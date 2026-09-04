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

function createUnifiedDiff(before, after, name) {
  if (before === after) return '';
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines = [`--- ${name}`, `+++ ${name}`];

  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) continue;
    if (left !== undefined) lines.push(`-${left}`);
    if (right !== undefined) lines.push(`+${right}`);
  }

  return lines.join('\n');
}
