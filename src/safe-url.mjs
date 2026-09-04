/**
 * Проверка адреса перед запросом: защита от SSRF.
 *
 * Почему это отдельный модуль. Проверка нужна в трёх местах: витрине, обходчику страниц и
 * MCP-эндпоинту. Пока она жила внутри веб-сервера, обходчик про неё не знал, и любой сайт
 * мог ответить перенаправлением на http://127.0.0.1 или на 169.254.169.254, то есть на
 * сервис метаданных облака. Первый адрес мы проверяли, а по перенаправлению уходили куда
 * скажут и возвращали содержимое запросившему. Одна проверка на входе тут не работает:
 * проверять надо каждый адрес, по которому мы реально идём.
 *
 * ALLOW_PRIVATE=1 снимает проверку целиком. Это только для локальной отладки, на публичном
 * хосте включать нельзя.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';

/**
 * Проверяет уже разобранный адрес. Отдельно от resolveSafeTarget, потому что при переходе
 * по перенаправлению разбирать заново нечего: адрес уже есть, надо только убедиться, что
 * идти по нему можно.
 */
export async function assertSafeUrl(raw) {
  const parsed = typeof raw === 'string' ? new URL(raw) : raw;

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Поддерживаются только адреса http и https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Адрес с логином и паролем проверить нельзя.');
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new Error('Проверяются только стандартные порты 80 и 443.');
  }
  if (ALLOW_PRIVATE) return parsed.toString();

  const addresses = await resolveAll(parsed.hostname);
  if (!addresses.length) throw new Error('Домен не резолвится. Проверьте адрес.');
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('Этот адрес ведёт во внутреннюю сеть, проверка таких адресов запрещена.');
    }
  }
  return parsed.toString();
}

/** Можно ли идти по этому адресу. Ошибку не бросает, нужна там, где проверка не повод падать. */
export async function isSafeUrl(raw) {
  try {
    await assertSafeUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Приводит присланный адрес к безопасной цели или бросает ошибку с человеческим текстом.
 *
 * Проверяется четыре вещи, и каждая закрывает свой класс злоупотребления:
 *   1. Схема только http и https. Иначе через file: и подобные можно читать локальные файлы.
 *   2. В адресе нет логина и пароля. Иначе наш сервер уйдёт авторизованным куда-то ещё.
 *   3. Порт стандартный. Иначе публичный сервис превращается в сканер портов чужой сети.
 *   4. Имя хоста резолвится в публичный адрес. Это и есть защита от SSRF: сравнивать
 *      строку "localhost" бесполезно, потому что любой домен можно направить на 127.0.0.1.
 */
export async function resolveSafeTarget(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('Укажите адрес сайта.');
  if (value.length > 2000) throw new Error('Слишком длинный адрес.');

  // Посетитель обычно вводит "mysite.ucoz.net" без схемы, дописываем https сами.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('Это не похоже на адрес сайта.');
  }

  return assertSafeUrl(parsed);
}

async function resolveAll(hostname) {
  // Литеральный IP в адресе резолвить не надо, он уже адрес.
  if (isIP(hostname)) return [hostname];
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    throw new Error('Домен не резолвится. Проверьте адрес.');
  }
}

/**
 * Приватные, служебные и петлевые диапазоны, куда публичный сервис ходить не должен.
 * Отдельно закрыт 169.254.169.254 и весь link-local: это адрес сервиса метаданных у всех
 * основных облаков, через который утекают ключи инстанса.
 */
function isPrivateAddress(address) {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fe80')) return true;           // link-local
    if (/^f[cd]/.test(value)) return true;               // unique local (fc00::/7)
    // IPv4, завёрнутый в IPv6 (::ffff:127.0.0.1), проверяем как IPv4.
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;

  if (a === 0) return true;                              // 0.0.0.0/8
  if (a === 10) return true;                             // приватная сеть
  if (a === 127) return true;                            // петля
  if (a === 169 && b === 254) return true;               // link-local и метаданные облака
  if (a === 172 && b >= 16 && b <= 31) return true;       // приватная сеть
  if (a === 192 && b === 168) return true;               // приватная сеть
  if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT
  if (a === 192 && b === 0) return true;                 // служебные 192.0.0.0/24 и 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;   // бенчмарк-сети
  if (a >= 224) return true;                             // multicast и зарезервированное
  return false;
}

/**
 * Отдаёт посетителю только то, что нужно витрине: сводку, топ проблем и разбивку по страницам.
 * Полный результат аудита это десятки килобайт со всем HTML и списками ссылок, гонять их в
 * браузер незачем.
 */
