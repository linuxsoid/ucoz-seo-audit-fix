import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function fixTemplateFile(file, options = {}) {
  const target = resolve(file);
  const original = await readFile(target, 'utf8');
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(target, backup);

  const preview = fixTemplateContent(original, options);
  if (preview.html !== original) await writeFile(target, preview.html, 'utf8');
  return { file: target, backup, changes: preview.changes, diff: preview.diff };
}

export function fixTemplateContent(original, options = {}) {
  const changes = [];
  let html = String(original ?? '');

  if (!hasMeta(html, 'name', 'viewport')) {
    html = insertIntoHead(html, '  <meta name="viewport" content="width=device-width, initial-scale=1">');
    changes.push('Добавлен meta viewport');
  }

  if (options.description && !hasMeta(html, 'name', 'description')) {
    html = insertIntoHead(html, `  <meta name="description" content="${escapeAttr(options.description)}">`);
    changes.push('Добавлен meta description');
  }

  if (!hasMeta(html, 'property', 'og:type')) {
    html = insertIntoHead(html, '  <meta property="og:type" content="website">');
    changes.push('Добавлен og:type');
  }

  if (options.title && !hasMeta(html, 'property', 'og:title')) {
    html = insertIntoHead(html, `  <meta property="og:title" content="${escapeAttr(options.title)}">`);
    changes.push('Добавлен og:title');
  }

  if (options.description && !hasMeta(html, 'property', 'og:description')) {
    html = insertIntoHead(html, `  <meta property="og:description" content="${escapeAttr(options.description)}">`);
    changes.push('Добавлен og:description');
  }

  if (!hasMeta(html, 'name', 'twitter:card')) {
    html = insertIntoHead(html, '  <meta name="twitter:card" content="summary">');
    changes.push('Добавлен twitter:card');
  }

  return {
    html,
    changes,
    changed: html !== original,
    diff: createUnifiedDiff(String(original ?? ''), html, options.name ?? 'template.html')
  };
}

function hasMeta(html, attr, value) {
  // Теги внутри комментариев не считаются: закомментированный <!-- <meta ...> --> это
  // не существующий тег, а заготовка. Раньше правка на такой заготовке молча не
  // применялась: код видел тег, которого для браузера нет.
  const tags = stripComments(html).match(/<meta\b[^>]*>/gi) ?? [];
  return tags.some((tag) => String(getAttr(tag, attr)).toLowerCase() === value.toLowerCase());
}

/** Убирает комментарии, чтобы разбор не считал их содержимое разметкой. */
function stripComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, '');
}

function insertIntoHead(html, line) {
  // Вставляем функцией, а не строкой.
  //
  // String.replace обрабатывает в строке замены служебные последовательности: $&, $`, $'
  // и $1. Значит title или description, в котором встретился знак доллара с такой буквой,
  // подставлял в шаблон не сам себя, а кусок исходного HTML. Пример: заголовок «Скидка $&
  // подарок» вставил бы вместо «$&» найденный </head>. Функция замены такие
  // последовательности не разбирает.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `\n${line}\n</head>`);
  return `${line}\n${html}`;
}

function getAttr(tag, attr) {
  const match = tag.match(new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

/**
 * Показывает, что именно меняется в шаблоне.
 *
 * Строки сравнивались по номеру, а правка здесь это вставка: одна добавленная строка
 * сдвигает вниз весь остаток файла, и сравнение по номеру объявляло изменёнными ВСЕ
 * строки после места вставки. На шаблоне в двести строк превью выглядело так, будто мы
 * стираем файл целиком и пишем заново, а в ответ тула уходило полное содержимое файла.
 *
 * Отрезаем совпадающее начало и совпадающий конец. Остаётся изменённая середина, а для
 * вставки это ровно вставленные строки и ни одной лишней.
 */
function createUnifiedDiff(before, after, name) {
  if (before === after) return '';
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);

  let head = 0;
  while (head < beforeLines.length && head < afterLines.length
    && beforeLines[head] === afterLines[head]) {
    head += 1;
  }

  let tail = 0;
  while (tail < beforeLines.length - head && tail < afterLines.length - head
    && beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]) {
    tail += 1;
  }

  const removed = beforeLines.slice(head, beforeLines.length - tail);
  const added = afterLines.slice(head, afterLines.length - tail);

  const lines = [
    `--- ${name}`,
    `+++ ${name}`,
    `@@ -${removed.length ? head + 1 : head},${removed.length} +${added.length ? head + 1 : head},${added.length} @@`
  ];
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);

  return lines.join('\n');
}
