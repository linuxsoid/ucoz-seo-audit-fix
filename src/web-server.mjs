#!/usr/bin/env node
/**
 * Публичный веб-сервис SEO-аудита.
 *
 * Зачем он нужен. MCP-сервер из этого же пакета рассчитан на владельца сайта: человек ставит
 * пакет себе в Codex или Cursor, подключает uCoz MCP со своим токеном и получает полный цикл
 * audit, fix, re-audit. Это узкая аудитория. Публичная проверка по URL нужна для другого
 * сценария: случайный посетитель вводит адрес своего сайта, за несколько секунд видит список
 * проблем и только после этого узнаёт, что часть из них чинится автоматически. То есть это
 * точка входа и лид-магнит, а не инструмент разработчика.
 *
 * Движок аудита переиспользуется один в один (auditSite из seo-audit.mjs), никакой второй
 * реализации проверок здесь нет.
 *
 * Чем публичный режим отличается от CLI и MCP. В CLI адрес вводит сам владелец, и он имеет
 * право просканировать что угодно. Здесь адрес приходит от анонимного посетителя, поэтому
 * добавлены три класса ограничений, которых в CLI нет и не должно быть:
 *   1. Защита от SSRF. Без неё любой желающий заставит наш сервер сходить на 127.0.0.1,
 *      в приватную сеть или на 169.254.169.254 (метаданные облака) и вернуть ему ответ.
 *   2. Лимит частоты по IP и глобальный лимит одновременных аудитов, чтобы один человек не
 *      занял весь процесс.
 *   3. Жёсткий потолок числа страниц: публичная проверка это витрина, а не полный обход.
 *
 * Lighthouse здесь СОЗНАТЕЛЬНО не запускается. Он поднимает Chrome, это сотни мегабайт памяти
 * и десятки секунд на один запрос, что на публичном эндпоинте превращается в готовый способ
 * положить машину. Lighthouse остаётся в MCP-режиме, где запрос делает сам владелец.
 *
 * Запуск:
 *   node src/web-server.mjs
 *   PORT=8080 MAX_PAGES=8 node src/web-server.mjs
 *
 * Переменные окружения:
 *   PORT             порт (по умолчанию 8787)
 *   HOST             интерфейс (по умолчанию 0.0.0.0)
 *   MAX_PAGES        сколько страниц обходить в публичном режиме (по умолчанию 8, потолок 20)
 *   RATE_LIMIT       сколько аудитов с одного IP за окно (по умолчанию 5)
 *   RATE_WINDOW_MS   длина окна лимита в миллисекундах (по умолчанию 600000, то есть 10 минут)
 *   MAX_CONCURRENT   сколько аудитов выполняется одновременно на весь сервис (по умолчанию 2)
 *   TRUST_PROXY      1, если сервис стоит за nginx и настоящий IP приходит в X-Forwarded-For
 *   BASE_PATH        префикс, на который смонтировано приложение, например /seo. Нужен,
 *                    когда хостинг вешает приложение не в корень домена: Passenger отдаёт
 *                    нам полный путь вместе с префиксом, и без этой настройки все маршруты
 *                    просто не совпадут. Если приложение в корне, оставить пустым
 *   ALLOW_PRIVATE    1 отключает защиту от приватных адресов. ТОЛЬКО для локальной отладки,
 *                    на публичном хосте включать нельзя
 */

import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { auditSite } from './seo-audit.mjs';
import { handleMcpRequest } from './mcp-http.mjs';
import { browserSlotStats } from './browser-slot.mjs';
import { runLighthouseAudit } from './lighthouse-audit.mjs';
import { collectBrowserDiagnostics } from './browser-probe.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
// Потолок в 20 страниц жёсткий: даже если кто-то выставит MAX_PAGES=500, публичный обход
// столько не сделает. Полный обход это сценарий владельца через MCP, а не витрины.
const MAX_PAGES = Math.min(Number(process.env.MAX_PAGES ?? 8), 20);
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 5);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 10 * 60 * 1000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
// Хостинг может смонтировать приложение по адресу вида https://site/seo/, и тогда
// в req.url приходит /seo/healthz, а не /healthz. Префикс снимаем один раз здесь,
// чтобы весь остальной роутинг не знал, куда именно приложение подвесили.
// Passenger в ряде сборок сам кладёт префикс в PASSENGER_BASE_URI, используем его как
// значение по умолчанию.
const BASE_PATH = String(process.env.BASE_PATH ?? process.env.PASSENGER_BASE_URI ?? '')
  .trim()
  .replace(/\/+$/, '');
// Аудит восьми страниц укладывается в несколько секунд. 60 секунд это аварийный потолок на
// случай очень медленного сайта: лучше вернуть посетителю честную ошибку, чем держать слот.
const AUDIT_TIMEOUT_MS = 60_000;

/**
 * Счётчик запросов по IP. Обычный Map в памяти процесса: сервис одноинстансный, внешнего
 * хранилища ради лимита заводить незачем. Записи чистятся лениво при обращении.
 */
const rateBuckets = new Map();
let running = 0;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = matchRoute(url.pathname);

    if (req.method === 'GET' && route === 'healthz') {
      return sendJson(res, 200, { ok: true, running, maxPages: MAX_PAGES, browser: browserSlotStats() });
    }
    if (req.method === 'OPTIONS' && (route === 'audit' || route === 'deep')) {
      // Форму можно встроить на лендинг seoaudit.ucoz.net, а он живёт на другом origin,
      // поэтому CORS для этого маршрута открыт осознанно. Эндпоинт ничего не пишет и не
      // читает состояние пользователя, отдавать его кросс-доменно безопасно.
      return sendCorsPreflight(res);
    }
    if (req.method === 'POST' && route === 'audit') {
      return await handleAudit(req, res);
    }
    if (req.method === 'POST' && route === 'deep') {
      return await handleDeepAudit(req, res);
    }
    // Remote MCP на том же порту и том же домене, что и витрина. Так на хостинге
    // получается один Node-апп и один URL: витрина для людей, /mcp для агентов.
    if (route === 'mcp') {
      return await handleMcpRequest(req, res);
    }
    if (req.method === 'GET') {
      return sendHtml(res, 200, renderPage());
    }

    return sendJson(res, 404, { error: 'Не найдено' });
  } catch (error) {
    return sendJson(res, 500, { error: 'Внутренняя ошибка', detail: String(error?.message ?? error) });
  }
});

/**
 * Определяет, какой маршрут запрошен, независимо от того, куда хостинг подвесил приложение.
 *
 * Зачем так, а не сравнение путей напрямую. Хостинг серверных скриптов uCoz монтирует
 * приложение не в корень домена, а на префикс вида /seo, и Passenger отдаёт нам полный
 * путь вместе с префиксом. Сравнение pathname === '/healthz' в такой конфигурации не
 * совпадёт никогда, и сервер будет отвечать собственным 404 на собственные же маршруты.
 *
 * Можно было бы требовать переменную BASE_PATH, но тогда развёртывание ломается от одной
 * забытой настройки в панели, причём ломается молча. Поэтому маршрут узнаётся по окончанию
 * пути: маршрутов всего три, они уникальны, и любой префикс перед ними значения не имеет.
 * BASE_PATH остаётся как явное переопределение, если однажды понадобится точный контроль.
 *
 * Всё, что не совпало ни с одним маршрутом, при GET отдаёт витрину. Для приложения из
 * четырёх ручек это правильное поведение: человек, открывший любой адрес внутри
 * приложения, должен увидеть форму проверки, а не сообщение об ошибке.
 */
function matchRoute(pathname) {
  const path = BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(BASE_PATH + '/'))
    ? (pathname.slice(BASE_PATH.length) || '/')
    : pathname;

  if (path === '/healthz' || path.endsWith('/healthz')) return 'healthz';
  if (path === '/api/audit' || path.endsWith('/api/audit')) return 'audit';
  if (path === '/api/deep' || path.endsWith('/api/deep')) return 'deep';
  if (path === '/mcp' || path.endsWith('/mcp')) return 'mcp';
  return 'page';
}

async function handleAudit(req, res) {
  const ip = clientIp(req);

  if (!takeRateToken(ip)) {
    return sendJson(res, 429, {
      error: 'Слишком много проверок с одного адреса. Попробуйте через несколько минут.'
    });
  }
  if (running >= MAX_CONCURRENT) {
    return sendJson(res, 503, {
      error: 'Сейчас идут другие проверки. Повторите запрос через полминуты.'
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: String(error.message) });
  }

  let target;
  try {
    target = await resolveSafeTarget(body?.url);
  } catch (error) {
    return sendJson(res, 400, { error: String(error.message) });
  }

  running += 1;
  const startedAt = Date.now();
  try {
    const result = await withTimeout(
      auditSite(target, { maxPages: MAX_PAGES, lighthouse: false }),
      AUDIT_TIMEOUT_MS,
      'Проверка заняла слишком много времени. Сайт отвечает медленно.'
    );
    return sendJson(res, 200, compactResult(result, Date.now() - startedAt));
  } catch (error) {
    return sendJson(res, 502, { error: String(error?.message ?? error) });
  } finally {
    running -= 1;
  }
}


/**
 * Глубокая проверка: Lighthouse плюс браузерная диагностика одной страницы.
 *
 * Отделена от обычной проверки сознательно. Обычная проверка это чистые HTTP-запросы,
 * она обходит восемь страниц за секунды и выдерживает любой поток посетителей. Глубокая
 * поднимает настоящий Chrome, занимает единственный слот браузера и идёт около минуты.
 * Смешивать их в одной кнопке нельзя: тогда каждый случайный посетитель запускал бы
 * браузер, и очередь встала бы намертво.
 *
 * Поэтому здесь свой, более жёсткий лимит по IP и явное предупреждение в интерфейсе,
 * что это дольше.
 */
async function handleDeepAudit(req, res) {
  const ip = clientIp(req);
  // Глубокая проверка дороже обычной примерно в двадцать раз, поэтому и лимит строже:
  // берём три токена вместо одного из того же окна.
  for (let i = 0; i < 3; i += 1) {
    if (!takeRateToken(ip)) {
      return sendJson(res, 429, {
        error: 'Глубокая проверка доступна ограниченно. Попробуйте через несколько минут.'
      });
    }
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: String(error.message) });
  }

  let target;
  try {
    target = await resolveSafeTarget(body?.url);
  } catch (error) {
    return sendJson(res, 400, { error: String(error.message) });
  }

  const formFactor = body?.formFactor === 'desktop' ? 'desktop' : 'mobile';

  try {
    // Запускаем последовательно, а не параллельно: слот браузера один, и параллельный
    // запуск просто заблокировал бы сам себя на ожидании очереди.
    const lighthouse = await runLighthouseAudit(target, {
      formFactor,
      categories: ['performance', 'accessibility', 'best-practices', 'seo'],
      output: []
    });
    const browser = await collectBrowserDiagnostics(target, { formFactor, waitMs: 4000 });

    return sendJson(res, 200, {
      url: target,
      formFactor,
      lighthouse: lighthouse?.available ? {
        categories: lighthouse.summary?.categories ?? [],
        metrics: lighthouse.summary?.metrics ?? [],
        topIssues: (lighthouse.summary?.topIssues ?? []).slice(0, 8)
      } : { unavailable: lighthouse?.reason ?? 'Lighthouse недоступен.' },
      browser: browser?.available ? {
        summary: browser.summary,
        consoleErrors: browser.consoleErrors.slice(0, 10),
        jsErrors: browser.jsErrors.slice(0, 10),
        failedRequests: browser.failedRequests.slice(0, 10),
        heaviestRequests: browser.heaviestRequests.slice(0, 8)
      } : { unavailable: browser?.reason ?? 'Диагностика недоступна.' }
    });
  } catch (error) {
    return sendJson(res, 502, { error: String(error?.message ?? error) });
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
async function resolveSafeTarget(raw) {
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

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Поддерживаются только адреса http и https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Адрес с логином и паролем проверить нельзя.');
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new Error('Проверяются только стандартные порты 80 и 443.');
  }

  if (!ALLOW_PRIVATE) {
    const addresses = await resolveAll(parsed.hostname);
    if (!addresses.length) throw new Error('Домен не резолвится. Проверьте адрес.');
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error('Этот адрес ведёт во внутреннюю сеть, проверка таких адресов запрещена.');
      }
    }
  }

  return parsed.toString();
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
function compactResult(result, ms) {
  const issues = (result.checks ?? []).filter((check) => check.severity !== 'pass');
  const byCode = new Map();
  for (const issue of issues) {
    const entry = byCode.get(issue.code) ?? {
      code: issue.code, severity: issue.severity, count: 0,
      message: issue.message, fix: issue.fix, pages: []
    };
    entry.count += 1;
    // Список страниц нужен, чтобы отчёт можно было использовать, а не только смотреть:
    // без него человек видит «нет H1 на 8 страницах» и не знает, на каких именно.
    if (issue.url && entry.pages.length < 30 && !entry.pages.includes(issue.url)) {
      entry.pages.push(issue.url);
    }
    // Критичность группы это максимум по группе: одна критичная страница делает проблему критичной.
    if (issue.severity === 'critical') entry.severity = 'critical';
    byCode.set(issue.code, entry);
  }

  const grouped = [...byCode.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return b.count - a.count;
  });

  return {
    url: result.startUrl,
    scannedAt: result.scannedAt,
    ms,
    pagesScanned: (result.pages ?? []).length,
    summary: result.summary,
    issues: grouped.slice(0, 25),
    pages: (result.pages ?? []).map((page) => ({
      url: page.url,
      title: page.title ?? '',
      status: page.status,
      critical: (page.checks ?? []).filter((check) => check.severity === 'critical').length,
      recommended: (page.checks ?? []).filter((check) => check.severity === 'recommended').length
    }))
  };
}

/** Простое окно с фиксированным сбросом. Точность секунда в секунду тут не нужна. */
function takeRateToken(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.startedAt > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    if (rateBuckets.size > 5000) pruneRateBuckets(now);
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

function pruneRateBuckets(now) {
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.startedAt > RATE_WINDOW_MS) rateBuckets.delete(ip);
  }
}

/**
 * X-Forwarded-For читаем только при TRUST_PROXY=1. Без прокси этот заголовок подделывает
 * кто угодно, и лимит по IP перестаёт что-либо ограничивать.
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('Слишком большой запрос.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Тело запроса должно быть корректным JSON.');
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html)
  });
  res.end(html);
}

function sendCorsPreflight(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  });
  res.end();
}

/**
 * Страница витрины. Отдаётся одним куском без внешних файлов и без CDN: так сервис можно
 * поднять где угодно одной командой, и он не зависит от чужой доступности.
 */
function renderPage() {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO-аудит сайта uCoz за 10 секунд</title>
<style>
  :root { color-scheme: light; --bg:#f6f5f1; --ink:#14141a; --muted:#6b6b76; --line:#e2e0da;
          --crit:#d64f3c; --rec:#c98a1c; --ok:#1f9d64; --accent:#111; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: clamp(28px,5vw,44px); line-height:1.1; margin:0 0 12px; letter-spacing:-0.02em; }
  .lead { color:var(--muted); margin:0 0 28px; max-width:60ch; }
  form { display:flex; gap:10px; flex-wrap:wrap; }
  input[type=url] { flex:1 1 320px; min-width:0; padding:14px 16px; font-size:16px;
                    border:1px solid var(--line); border-radius:10px; background:#fff; }
  input[type=url]:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { padding:14px 24px; font-size:16px; font-weight:600; border:0; border-radius:10px;
           background:var(--accent); color:#fff; cursor:pointer; }
  button[disabled] { opacity:.5; cursor:progress; }
  .note { color:var(--muted); font-size:13px; margin-top:10px; }
  .msg { margin-top:22px; padding:14px 16px; border-radius:10px; background:#fff;
         border:1px solid var(--line); }
  .msg.err { border-color:var(--crit); color:var(--crit); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
           gap:12px; margin:26px 0 8px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; }
  .card b { display:block; font-size:32px; line-height:1.1; }
  .card span { color:var(--muted); font-size:13px; }
  .card.crit b { color:var(--crit); } .card.rec b { color:var(--rec); } .card.ok b { color:var(--ok); }
  ul.issues { list-style:none; padding:0; margin:18px 0 0; }
  ul.issues li { background:#fff; border:1px solid var(--line); border-radius:10px;
                 padding:14px 16px; margin-bottom:10px; }
  .tag { display:inline-block; font-size:12px; font-weight:600; padding:2px 8px;
         border-radius:999px; margin-right:8px; }
  .tag.critical { background:#fdeae7; color:var(--crit); }
  .tag.recommended { background:#fdf3e0; color:var(--rec); }
  .issue-fix { color:var(--muted); font-size:14px; margin-top:6px; }
  .cta { margin-top:28px; padding:18px 20px; background:#fff; border:1px solid var(--line);
         border-radius:12px; }
  code { background:#eeece6; padding:1px 5px; border-radius:4px; font-size:13px; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; --bg:#14141a; --ink:#f2f1ee; --muted:#9a9aa4; --line:#2c2c36;
            --accent:#f2f1ee; }
    body { background:var(--bg); color:var(--ink); }
    input[type=url], .msg, .card, ul.issues li, .cta { background:#1c1c24; color:var(--ink); }
    button { color:#14141a; }
    code { background:#2c2c36; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>SEO-аудит сайта за десять секунд</h1>
  <p class="lead">Введите адрес сайта. Проверим мета-теги, заголовки, canonical, Open Graph,
    Schema.org, alt у картинок, robots, sitemap и внутренние ссылки. Регистрация не нужна.</p>

  <form id="f">
    <input id="u" type="url" placeholder="mysite.ucoz.net" required autocomplete="url">
    <button id="b" type="submit">Проверить</button>
  </form>
  <p class="note">Смотрим до ${MAX_PAGES} страниц. Сайт не меняется, проверка только читает.</p>

  <div id="out"></div>
</div>
<script>
const form = document.getElementById('f');
const input = document.getElementById('u');
const button = document.getElementById('b');
const out = document.getElementById('out');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = 'Проверяю';
  out.innerHTML = '<div class="msg">Обхожу страницы, это несколько секунд.</div>';

  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не получилось проверить сайт.');
    render(data);
  } catch (error) {
    out.innerHTML = '<div class="msg err">' + escapeHtml(error.message) + '</div>';
  } finally {
    button.disabled = false;
    button.textContent = 'Проверить';
  }
});

function render(data) {
  const s = data.summary || {};
  const cards =
    '<div class="cards">' +
      card('crit', s.critical || 0, 'критичных') +
      card('rec', s.recommended || 0, 'рекомендаций') +
      card('ok', s.passed || 0, 'проверок OK') +
      card('', data.pagesScanned || 0, 'страниц') +
    '</div>';

  const issues = (data.issues || []).length
    ? '<ul class="issues">' + data.issues.map(issueRow).join('') + '</ul>'
    : '<div class="msg">По текущему набору проверок заметных проблем не обнаружено.</div>';

  const cta =
    '<div class="cta"><b>Часть найденных проблем можно исправить автоматически.</b><br>' +
    'Поставьте MCP себе в Codex, Cursor или Claude, подключите свой uCoz-сайт по токену, ' +
    'и после подтверждения система применит подготовленные изменения и покажет diff до записи. ' +
    '<a href="/#install">Как подключить</a></div>';

  out.innerHTML = cards + issues + cta;
}

function card(kind, value, label) {
  return '<div class="card ' + kind + '"><b>' + value + '</b><span>' + label + '</span></div>';
}

function issueRow(issue) {
  const label = issue.severity === 'critical' ? 'критично' : 'рекомендация';
  return '<li><span class="tag ' + issue.severity + '">' + label + '</span>' +
    '<b>' + escapeHtml(issue.message || issue.code) + '</b>' +
    ' <code>' + escapeHtml(issue.code) + '</code>' +
    (issue.count > 1 ? ' <span class="note">на ' + issue.count + ' стр.</span>' : '') +
    (issue.fix ? '<div class="issue-fix">' + escapeHtml(issue.fix) + '</div>' : '') +
  '</li>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]
  ));
}
</script>
</body>
</html>`;
}

server.listen(PORT, HOST, () => {
  console.log(`SEO web checker слушает http://${HOST}:${PORT}`);
  console.log(`страниц за проверку: ${MAX_PAGES}, лимит: ${RATE_LIMIT} за ${RATE_WINDOW_MS / 60000} мин, параллельно: ${MAX_CONCURRENT}`);
  console.log(`remote MCP: http://${HOST}:${PORT}${BASE_PATH}/mcp`);
  if (BASE_PATH) console.log(`приложение смонтировано на префикс ${BASE_PATH}`);
  if (ALLOW_PRIVATE) console.warn('ВНИМАНИЕ: ALLOW_PRIVATE=1, защита от приватных адресов выключена. Только для локальной отладки.');
});
