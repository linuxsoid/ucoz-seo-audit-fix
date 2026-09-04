/**
 * Тесты страницы лендинга.
 *
 * Клиентский скрипт не запускается в node без браузера, поэтому здесь проверяется то, что
 * можно проверить по самому файлу, и именно то, что уже ломалось на живом сайте:
 *   1. Скрипт разбирается. Один лишний обратный слэш в регулярке уронил весь блок, и
 *      форма проверки перестала перехватываться: она уходила обычной отправкой на 404.
 *   2. Нет вызовов удалённых функций. Правка вырезала функцию вместе с соседями, и вторая
 *      половина проверки падала на renderDeep is not defined.
 *   3. Шаблон uCoz совпадает с index.html. Файлы разъезжались дважды за день, и на живом
 *      сайте работала старая версия скрипта.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['site/index.html', 'site/homepage-own-template.html'];

/** Блоки скрипта без src и без чужого типа: только настоящий JavaScript страницы. */
function scriptBlocks(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc=/i.test(attrs)) continue;
    if (/type=["'](?!text\/javascript|application\/javascript|module)/i.test(attrs)) continue;
    out.push(m[2]);
  }
  return out;
}

for (const page of PAGES) {
  test(`${page}: весь JavaScript разбирается без ошибок`, async () => {
    const html = await readFile(join(ROOT, page), 'utf8');
    const blocks = scriptBlocks(html);
    assert.ok(blocks.length >= 2, `ожидали как минимум два блока скрипта, нашли ${blocks.length}`);

    for (let i = 0; i < blocks.length; i += 1) {
      const file = join(tmpdir(), `seo-site-check-${i}-${page.replace(/\W/g, '')}.mjs`);
      await writeFile(file, blocks[i], 'utf8');
      try {
        await run(process.execPath, ['--check', file]);
      } catch (error) {
        assert.fail(`блок ${i} не разбирается:\n${error.stderr || error.message}`);
      } finally {
        await unlink(file).catch(() => {});
      }
    }
  });

  test(`${page}: нет вызовов удалённых функций`, async () => {
    const html = await readFile(join(ROOT, page), 'utf8');
    const js = scriptBlocks(html).join('\n');

    // Собираем объявленные функции и сравниваем с вызванными. Список исключений это
    // встроенные в браузер и в язык вещи, которые объявлять не надо.
    const declared = new Set([...js.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]));
    const known = new Set([
      // встроенное в браузер и в язык
      'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN',
      'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise',
      'Error', 'RegExp', 'require', 'alert', 'confirm',
      // ключевые слова и операторы: за ними тоже стоит круглая скобка
      'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
      'void', 'delete', 'instanceof', 'in', 'of', 'do', 'else', 'await', 'yield'
    ]);

    const called = [...js.matchAll(/(?:^|[^.\w$])(\w+)\s*\(/g)].map((m) => m[1]);
    const missing = [...new Set(called)].filter((name) =>
      !declared.has(name) && !known.has(name) && /^[a-z][A-Za-z0-9]*$/.test(name)
        && !name.startsWith('on') && js.includes(`${name}(`)
        // Локальные переменные-функции и методы объектов сюда не попадают: берём только
        // то, что выглядит вызовом свободной функции и нигде не объявлено.
        && !new RegExp(`(var|let|const)\\s+${name}\\s*=`).test(js)
    );

    assert.deepEqual(missing, [], `вызовы необъявленных функций: ${missing.join(', ')}`);
  });
}

test('шаблон uCoz собран из index.html и не разошёлся с ним', async () => {
  // Сборщик сам сравнивает файлы и падает с ненулевым кодом, если они разъехались.
  await run(process.execPath, [join(ROOT, 'scripts', 'build-ucoz-template.mjs'), '--check'], { cwd: ROOT });
});

test('на странице есть переключатель темы и кнопка наверх', async () => {
  const html = await readFile(join(ROOT, 'site', 'index.html'), 'utf8');
  assert.ok(html.includes('id="theme-toggle"'), 'нет переключателя темы');
  assert.ok(html.includes('id="to-top"'), 'нет кнопки «наверх»');
  assert.ok(html.includes('data-theme="dark"'), 'нет правил тёмной темы');
  assert.ok(html.includes('prefers-color-scheme: dark'), 'тема не следует за настройкой системы');
});

test('поле ввода адреса стоит на первом экране', async () => {
  const html = await readFile(join(ROOT, 'site', 'index.html'), 'utf8');
  const hero = html.indexOf('class="hero"');
  const input = html.indexOf('id="check-url"');
  const secondSection = html.indexOf('<section id="steps"');

  assert.ok(hero !== -1 && input !== -1, 'не найден первый экран или поле ввода');
  assert.ok(input > hero && input < secondSection,
    'поле ввода должно быть внутри первого экрана, а не отдельной секцией ниже сгиба');
});

test('в подвале нет личной почты, а есть форма поддержки', async () => {
  // На живом сайте в подвале стояла личная рабочая почта одного из авторов, и заметил это
  // не автор, а тимейт. Личный адрес на публичной странице собирает спам и уводит вопросы
  // из поддержки в личку, поэтому тут закреплено: только форма поддержки uCoz.
  for (const page of PAGES) {
    const html = await readFile(join(ROOT, page), 'utf8');
    const footer = html.slice(html.indexOf('<footer'));

    assert.equal(/mailto:/i.test(footer), false, `${page}: в подвале снова появилась почта`);
    assert.ok(footer.includes('https://www.ucoz.ru/contact/'), `${page}: нет ссылки на форму поддержки uCoz`);
    for (const name of ['Андрей Игинов', 'Юрий Герук', 'Владислав Гевел']) {
      assert.ok(footer.includes(name), `${page}: в подвале не указан ${name}`);
    }
  }
});
