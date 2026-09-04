#!/usr/bin/env node
/**
 * Собирает шаблон страницы uCoz из site/index.html.
 *
 * Зачем. Лендинг существует в двух файлах: обычная страница и шаблон страницы uCoz,
 * который публикуется на seoaudit.ucoz.net. Разметка и скрипт в них должны быть
 * одинаковыми, а отличие ровно одно: в подвале шаблона стоит $POWERED_BY$, который uCoz
 * заменяет на свою подпись.
 *
 * Держать это руками не получается. За один день файлы разъехались дважды: в шаблоне
 * оставалась старая версия скрипта, и на живом сайте работало не то, что в репозитории.
 * Поэтому шаблон теперь не редактируется, а собирается: правки вносятся только в
 * site/index.html.
 *
 * Запуск: node scripts/build-ucoz-template.mjs
 * Проверка без записи: node scripts/build-ucoz-template.mjs --check
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'site', 'index.html');
const TARGET = join(ROOT, 'site', 'homepage-own-template.html');

/**
 * Куда вставить подпись uCoz. В подвале index.html стоит метка-комментарий: она ничего не
 * показывает человеку, но точно указывает место. Раньше якорем был текст подвала, и первая
 * же правка формулировки (убрали личную почту) сломала бы сборку.
 */
const ANCHOR = '<!--POWERED-->';
const POWERED = '<span style="display:inline-block;margin-left:10px">$POWERED_BY$</span>';

function build(html) {
  if (html.includes('$POWERED_BY$')) {
    throw new Error('в site/index.html не должно быть $POWERED_BY$: это метка шаблона uCoz');
  }
  if (!html.includes(ANCHOR)) {
    throw new Error(`в подвале site/index.html не найдена метка ${ANCHOR}: без неё подпись uCoz вставить некуда`);
  }
  if (html.split(ANCHOR).length !== 2) {
    throw new Error(`метка ${ANCHOR} в site/index.html встречается больше одного раза`);
  }
  const at = html.indexOf(ANCHOR);
  return html.slice(0, at) + POWERED + html.slice(at + ANCHOR.length);
}

const source = await readFile(SOURCE, 'utf8');
const built = build(source);

if (process.argv.includes('--check')) {
  const current = await readFile(TARGET, 'utf8').catch(() => '');
  if (current === built) {
    console.log('шаблон uCoz совпадает с index.html');
    process.exit(0);
  }
  console.error('шаблон uCoz разошёлся с index.html. Соберите заново: node scripts/build-ucoz-template.mjs');
  process.exit(1);
}

await writeFile(TARGET, built, 'utf8');
console.log(`шаблон uCoz собран из index.html: ${built.length} символов`);
