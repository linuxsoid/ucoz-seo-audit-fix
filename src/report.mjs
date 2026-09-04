import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { humanize, LIGHTHOUSE_HUMAN } from './human-labels.mjs';

export async function writeReports(result, options = {}) {
  const format = options.format ?? 'all';
  const outDir = resolve('reports');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `seo-report-${stamp}`;
  const files = [];

  if (format === 'all' || format === 'json') {
    const file = join(outDir, `${base}.json`);
    await writeFile(file, JSON.stringify(result, null, 2), 'utf8');
    files.push(file);
  }

  if (format === 'all' || format === 'markdown') {
    const file = join(outDir, `${base}.md`);
    await writeFile(file, toMarkdown(result), 'utf8');
    files.push(file);
  }

  if (format === 'all' || format === 'html') {
    const file = join(outDir, `${base}.html`);
    await writeFile(file, toHtml(result), 'utf8');
    files.push(file);
  }

  return files;
}

/**
 * Тот же отчёт обычным текстом.
 *
 * Нужен, чтобы вставить в переписку, отдать исполнителю или прочитать в редакторе. Порядок
 * и формулировки такие же, как в HTML: человек не должен переучиваться, открыв другой файл.
 * Кружков и полос тут быть не может, но вердикт, приоритет и человеческие названия
 * остаются, а именно в них весь смысл.
 */
export function toMarkdown(result) {
  const issues = result.checks.filter((check) => check.severity !== 'pass');
  const passed = result.checks.filter((check) => check.severity === 'pass');
  const groups = groupIssuesByProblem(issues);
  const blockers = groups.filter((g) => g.severity === 'critical');
  const advice = groups.filter((g) => g.severity !== 'critical');
  const verdict = buildVerdict(result, blockers, advice);

  const job = (group, index) => {
    const human = humanize(group.code);
    const sample = group.checks[0];
    const pages = group.urls.length;
    const lines = [`### ${index}. ${human?.title ?? sample.message}`, ''];
    lines.push(group.severity === 'critical' ? '**Срочно.**' : 'Улучшение.');
    if (human?.cost) lines.push(human.cost);
    lines.push('');
    if (sample.fix) lines.push(`Что сделать: ${sample.fix}`);
    if (human?.effortLabel) lines.push(`Сложность: ${human.effortLabel}`);
    lines.push('');
    if (pages) {
      lines.push(pages > 1 ? `Затронуто страниц: ${pages}${pages > 6 ? ', первые шесть' : ''}` : 'Где:');
      for (const u of group.urls.slice(0, 6)) lines.push(`- ${u}`);
      lines.push('');
    }
    lines.push(`Машинный код проблемы: \`${group.code}\``);
    return lines.join('\n');
  };

  const parts = [];
  parts.push(`# Что не так с сайтом ${hostOf(result.startUrl)}`, '');
  parts.push(`Проверено ${dateHuman(result.scannedAt)}. Страниц просмотрено: ${result.pages.length}.`);
  parts.push('В ваш сайт мы ничего не меняли, только читали страницы.', '');
  parts.push(`## ${verdict.line}`, '', verdict.hint, '');
  parts.push('| | |', '| --- | ---: |');
  parts.push(`| Срочно, мешает поиску | ${blockers.length} |`);
  parts.push(`| Стоит улучшить | ${advice.length} |`);
  parts.push(`| Проверок пройдено | ${passed.length} |`, '');

  const first = groups.slice(0, 3);
  const rest = groups.slice(3);
  if (first.length) {
    parts.push('## С чего начать', '');
    first.forEach((g, i) => parts.push(job(g, i + 1), ''));
  }
  if (rest.length) {
    parts.push('## Остальное, когда дойдут руки', '');
    rest.forEach((g, i) => parts.push(job(g, i + 1 + first.length), ''));
  }

  parts.push('## Скорость и техника', '', formatLighthouse(result.lighthouse), '');

  if (passed.length) {
    parts.push('## Что проверили и всё хорошо', '');
    for (const m of dedupeMessages(passed)) parts.push(`- ${m}`);
    parts.push('');
  }

  const skipped = result.skippedUrls ?? [];
  if (skipped.length) {
    parts.push('## Почему проверено не всё', '');
    parts.push(`Пропущено служебных страниц: ${skipped.length}. Это страницы, которые конструктор`);
    parts.push('делает сам: политика, соглашение, оформление заказа, страница ошибки. Их SEO ни на что');
    parts.push('не влияет, а в отчёте они создавали десятки одинаковых замечаний.', '');
  }

  parts.push('---', '');
  parts.push('Отчёт составлен инструментом SEO Audit & Fix. Проверка читает только публично');
  parts.push('доступные страницы, как это делает поисковый робот, и ничего в сайте не меняет.', '');

  return parts.join('\n');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url || 'сайт'); }
}

/**
 * HTML-отчёт для человека.
 *
 * Отчёт читает владелец сайта, а не сеошник. Поэтому порядок здесь не «по разделам
 * проверки», а по тому, как человек думает:
 *   1. Всё плохо или всё нормально. Одна фраза, крупно.
 *   2. Что делать первым. Три дела, не тридцать.
 *   3. Остальное, сгруппированное по проблеме, а не по странице: «нет описания на восьми
 *      страницах» это одна работа, а не восемь.
 *   4. Что уже в порядке. Это важно: отчёт из одних претензий выглядит приговором.
 *
 * Каждая проблема названа человеческими словами, и под ней написано, чем она грозит.
 * Машинный код тоже остаётся, мелким шрифтом: с ним человек сможет искать в интернете и
 * отдать задачу исполнителю.
 *
 * Ни одного скрипта и ни одной внешней картинки: файл открывают двойным щелчком с диска,
 * иногда без интернета, а ещё он отдаётся живой страницей с запретом скриптов. Кружки
 * оценок нарисованы через conic-gradient, полосы через градиент фона.
 */
export function toHtml(result) {
  const issues = result.checks.filter((check) => check.severity !== 'pass');
  const passed = result.checks.filter((check) => check.severity === 'pass');
  const groups = groupIssuesByProblem(issues);
  const blockers = groups.filter((g) => g.severity === 'critical');
  const advice = groups.filter((g) => g.severity !== 'critical');
  const first = groups.slice(0, 3);
  const rest = groups.slice(3);
  const host = hostOf(result.startUrl);
  const verdict = buildVerdict(result, blockers, advice);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Что не так с сайтом ${esc(host)}</title>
  <meta name="description" content="Проверка ${esc(host)} от ${esc(String(result.scannedAt).slice(0, 10))}: срочных проблем ${blockers.length}, улучшений ${advice.length}.">
  <!-- Отчёт это рабочий файл, а не страница для поиска: индексировать его незачем,
       иначе чужие отчёты начнут попадать в выдачу вместо самого сервиса. -->
  <meta name="robots" content="noindex, nofollow">
  <style>
    /* Светлая и тёмная тема одними переменными: отчёт открывают и днём, и ночью, а
       переключателя в скачанном файле быть не может, скрипты в нём запрещены. */
    :root {
      --bg: #f7f6f3; --panel: #ffffff; --line: #e4dfd7; --ink: #191c22; --muted: #5f6875;
      --accent: #1f5fd0; --crit-bg: #fdecec; --crit-ink: #a01717; --crit-line: #f4c9c9;
      --rec-bg: #fff6e0; --rec-ink: #7a5100; --rec-line: #f3e0b4;
      --ok-bg: #e9f7ef; --ok-ink: #17693c; --ok-line: #c9e9d6;
      --code-bg: #f1eee9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #14161a; --panel: #1c1f25; --line: #2c313a; --ink: #eceef2; --muted: #9aa4b2;
        --accent: #7aa7ff; --crit-bg: #341b1b; --crit-ink: #ff9b9b; --crit-line: #4d2626;
        --rec-bg: #33280f; --rec-ink: #ffd280; --rec-line: #4a3a17;
        --ok-bg: #16301f; --ok-ink: #86e0ab; --ok-line: #21462d;
        --code-bg: #262b33;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink);
      font: 16px/1.6 Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    main { max-width: 900px; margin: 0 auto; padding: 26px 20px 60px; }
    h1 { font-size: 27px; line-height: 1.25; margin: 0 0 6px; }
    h2 { font-size: 20px; margin: 34px 0 12px; }
    h3 { font-size: 17px; margin: 0 0 6px; }
    p { margin: 0 0 12px; }
    a { color: var(--accent); }
    .sub { color: var(--muted); font-size: 14px; margin: 0 0 22px; }

    .verdict { background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--tone, var(--accent));
      border-radius: 12px; padding: 20px 22px; margin: 0 0 22px; }
    .verdict.crit { --tone: #d94a4a; }
    .verdict.rec { --tone: #e0a92b; }
    .verdict.ok { --tone: #2fa86a; }
    .verdict-line { font-size: 21px; font-weight: 700; line-height: 1.35; margin: 0 0 8px; }
    .verdict p { margin: 0; color: var(--muted); }

    .counts { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 8px; }
    .count { flex: 1 1 150px; background: var(--panel); border: 1px solid var(--line);
      border-radius: 10px; padding: 13px 15px; }
    .count b { display: block; font-size: 26px; line-height: 1.1; }
    .count span { font-size: 13px; color: var(--muted); }

    .job { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
      padding: 16px 18px; margin: 0 0 12px; }
    .job.crit { border-color: var(--crit-line); background: var(--crit-bg); }
    .job-top { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .num { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%; background: var(--accent);
      color: #fff; font-size: 14px; font-weight: 700; display: flex; align-items: center;
      justify-content: center; }
    .cost { color: var(--muted); margin: 6px 0 10px; }
    .where { font-size: 13px; color: var(--muted); }
    .where ul { margin: 6px 0 0; padding-left: 18px; }
    .where li { overflow-wrap: anywhere; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .tag { font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line);
      color: var(--muted); background: var(--bg); }
    .tag.crit { background: var(--crit-bg); color: var(--crit-ink); border-color: var(--crit-line); }
    .tag.rec { background: var(--rec-bg); color: var(--rec-ink); border-color: var(--rec-line); }
    .code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; background: var(--code-bg);
      border-radius: 5px; padding: 2px 6px; color: var(--muted); }

    /* Кружок оценки: заливка по кругу до нужного процента, дырка в середине. */
    .rings { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); }
    .ring-card { background: var(--panel); border: 1px solid var(--line);
      border-radius: 10px; padding: 15px; display: flex; gap: 13px; align-items: flex-start; }
    .ring { flex: 0 0 auto; width: 54px; height: 54px; border-radius: 50%;
      background: conic-gradient(var(--c) calc(var(--p) * 1%), var(--line) 0);
      display: flex; align-items: center; justify-content: center; }
    .ring i { width: 42px; height: 42px; border-radius: 50%; background: var(--panel);
      display: flex; align-items: center; justify-content: center;
      font-style: normal; font-weight: 700; font-size: 15px; }
    .ring-card b { display: block; font-size: 15px; }
    .ring-card span { font-size: 13px; color: var(--muted); }

    .bar { height: 9px; border-radius: 999px; background: var(--line); overflow: hidden; margin: 8px 0 0; }
    .bar i { display: block; height: 100%; background: #2fa86a; }

    details { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
      padding: 13px 16px; margin: 0 0 12px; }
    summary { cursor: pointer; font-weight: 600; }
    details ul { margin: 10px 0 0; padding-left: 20px; }
    details li { overflow-wrap: anywhere; }

    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line);
      color: var(--muted); font-size: 13px; }

    @media print {
      body { background: #fff; }
      .job, .count, .ring-card, details, .verdict { break-inside: avoid; }
      details { display: block; }
      details > *:not(summary) { display: block !important; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Что не так с сайтом ${esc(host)}</h1>
    <p class="sub">Проверено ${esc(dateHuman(result.scannedAt))} · страниц просмотрено: ${result.pages.length} · в ваш сайт мы ничего не меняли, только читали</p>

    <div class="verdict ${verdict.tone}">
      <p class="verdict-line">${esc(verdict.line)}</p>
      <p>${esc(verdict.hint)}</p>
    </div>

    <div class="counts">
      <div class="count"><b>${blockers.length}</b><span>срочно, мешает поиску</span></div>
      <div class="count"><b>${advice.length}</b><span>стоит улучшить</span></div>
      <div class="count"><b>${passed.length}</b><span>проверок пройдено</span></div>
    </div>
    ${passBar(passed.length, result.checks.length)}

    ${first.length ? `<h2>С чего начать</h2>
    ${first.map((g, i) => jobCard(g, i + 1)).join('')}` : ''}

    ${rest.length ? `<h2>Остальное, когда дойдут руки</h2>
    ${rest.map((g, i) => jobCard(g, i + 1 + first.length)).join('')}` : ''}

    ${toHtmlLighthouse(result.lighthouse)}

    ${passed.length ? `<h2>Что проверили и всё хорошо</h2>
    <details><summary>${passed.length} ${plural(passed.length, 'проверка', 'проверки', 'проверок')} без замечаний</summary>
      <ul>${dedupeMessages(passed).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
    </details>` : ''}

    ${toHtmlSkippedUrls(result.skippedUrls ?? [])}

    <footer>
      Отчёт составлен инструментом SEO Audit &amp; Fix. Проверка читает только публично
      доступные страницы, как это делает поисковый робот, и ничего в сайте не меняет.
    </footer>
  </main>
</body>
</html>`;
}

/**
 * Вердикт одной фразой.
 *
 * Это первое и часто единственное, что человек прочитает. Поэтому здесь нет чисел без
 * смысла и нет запугивания: сказано состояние и сказано, что делать дальше.
 */
function buildVerdict(result, blockers, advice) {
  const host = hostOf(result.startUrl);

  const stopper = blockers.find((g) => g.code === 'site.robots_blocks_all' || g.code === 'index.noindex');
  if (stopper) {
    return {
      tone: 'crit',
      line: 'Сайт закрыт от поисковых систем',
      hint: 'Это единственное, что имеет смысл чинить сейчас. Пока запрет стоит, страницы в поиск не попадут, и остальные правки ничего не изменят.'
    };
  }

  if (blockers.length) {
    return {
      tone: 'crit',
      line: `Есть ${blockers.length} ${plural(blockers.length, 'проблема', 'проблемы', 'проблем')}, ${plural(blockers.length, 'которая мешает', 'которые мешают', 'которые мешают')} поиску`,
      hint: 'Начните с них: они влияют на то, попадёт ли сайт в поиск и как он там выглядит. Остальное подождёт.'
    };
  }

  if (advice.length) {
    return {
      tone: 'rec',
      line: 'Ничего сломанного не нашли',
      hint: `С ${esc(host)} всё в порядке по основным проверкам. Осталось ${advice.length} ${plural(advice.length, 'улучшение', 'улучшения', 'улучшений')}: они не срочные, но каждое немного добавляет сайту видимости в поиске.`
    };
  }

  return {
    tone: 'ok',
    line: 'С сайтом всё в порядке',
    hint: 'Проверка не нашла ни проблем, ни поводов для улучшений. Такое бывает редко.'
  };
}

/**
 * Группирует замечания по проблеме, а не по странице.
 *
 * «Нет описания» на восьми страницах это одна работа, а не восемь пунктов. Прошлый отчёт
 * группировал по страницам, и одна забытая настройка шаблона превращалась в восемь
 * одинаковых блоков, между которыми невозможно разобраться, что делать.
 *
 * Порядок: сначала критичное, внутри по числу затронутых страниц. Так наверху оказывается
 * то, что и важно, и повторяется чаще всего, то есть одна правка даёт больше всего.
 */
function groupIssuesByProblem(issues) {
  const map = new Map();
  for (const check of issues) {
    const code = String(check.code);
    if (!map.has(code)) {
      map.set(code, { code, severity: check.severity, checks: [], urls: [] });
    }
    const group = map.get(code);
    group.checks.push(check);
    // Критичность группы это критичность самого строгого из её замечаний.
    if (check.severity === 'critical') group.severity = 'critical';
    for (const u of [check.url, ...(check.relatedUrls ?? [])]) {
      if (u && !group.urls.includes(u)) group.urls.push(u);
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return b.urls.length - a.urls.length;
  });
}

/** Одна карточка дела: что, чем грозит, где и насколько трудно. */
function jobCard(group, index) {
  const human = humanize(group.code);
  const sample = group.checks[0];
  const title = human?.title ?? sample.message;
  const cost = human?.cost ?? '';
  const fix = sample.fix ?? '';
  const pages = group.urls.length;
  const crit = group.severity === 'critical';

  const where = pages
    ? `<div class="where">${pages > 1
        ? `Затронуто ${pages} ${plural(pages, 'страница', 'страницы', 'страниц')}${pages > 6 ? ', первые шесть' : ''}:`
        : 'Где:'}
        <ul>${group.urls.slice(0, 6).map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
      </div>`
    : '';

  return `<article class="job${crit ? ' crit' : ''}">
    <div class="job-top"><span class="num">${index}</span><h3>${esc(title)}</h3></div>
    ${cost ? `<p class="cost">${esc(cost)}</p>` : ''}
    ${fix ? `<p><b>Что сделать.</b> ${esc(fix)}</p>` : ''}
    ${where}
    <div class="tags">
      <span class="tag ${crit ? 'crit' : 'rec'}">${crit ? 'срочно' : 'улучшение'}</span>
      ${human?.effortLabel ? `<span class="tag">${esc(human.effortLabel)}</span>` : ''}
      <span class="code">${esc(group.code)}</span>
    </div>
  </article>`;
}

/** Полоса «сколько проверок пройдено». Показывает, что найденное это не весь сайт. */
function passBar(passed, total) {
  if (!total) return '';
  const percent = Math.round((passed / total) * 100);
  return `<div class="bar" role="img" aria-label="Без замечаний ${passed} проверок из ${total}"><i style="width:${percent}%"></i></div>
  <p class="sub" style="margin:8px 0 0">${passed} из ${total} проверок ${plural(passed, 'прошла', 'прошли', 'прошли')} без замечаний. Проверка смотрит на сам сайт: страницы, файлы и поведение в настоящем браузере.</p>`;
}

/** Одинаковые сообщения пройденных проверок сворачиваем: их бывает по восемь подряд. */
function dedupeMessages(checks) {
  const seen = new Map();
  for (const c of checks) {
    const key = c.message;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].map(([m, n]) => (n > 1 ? `${m} (на ${n} страницах)` : m));
}

function dateHuman(value) {
  const s = String(value ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Русские окончания. Без них выходит «3 проблема» и «5 проверки». */
function plural(n, one, few, many) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function formatLighthouse(lighthouse) {
  if (!lighthouse) return 'Lighthouse не запускался для этого отчёта.\n';
  if (!lighthouse.available) return `Lighthouse не запущен: ${lighthouse.message}\n`;

  const categories = lighthouse.summary.categories.length
    ? ['| Категория | Оценка |', '| --- | ---: |', ...lighthouse.summary.categories.map((item) => `| ${item.title} | ${item.score ?? '-'} |`)].join('\n')
    : 'Оценки категорий не получены.';
  const metrics = lighthouse.summary.metrics.length
    ? ['| Метрика | Значение | Оценка |', '| --- | --- | ---: |', ...lighthouse.summary.metrics.map((item) => `| ${item.label} | ${item.value || '-'} | ${item.score ?? '-'} |`)].join('\n')
    : 'Метрики не получены.';
  const issues = lighthouse.summary.topIssues.length
    ? lighthouse.summary.topIssues.map((item) => `**${severityLabel(item.severity)}** · \`lighthouse.${item.id}\`\n\n${item.message}\nЧто сделать: ${item.fix}`).join('\n\n')
    : 'Крупных рекомендаций Lighthouse не найдено.';
  const files = lighthouse.reportFiles?.length ? `\nФайлы Lighthouse: ${lighthouse.reportFiles.join(', ')}\n` : '';

  return `Проверенный URL: ${lighthouse.url}
Профиль: ${lighthouse.formFactor}
${files}
### Оценки

${categories}

### Метрики

${metrics}

### Главные рекомендации

${issues}
`;
}

/**
 * Оценки Lighthouse кружками, а не числами в рамке.
 *
 * Число «62» само по себе ничего не говорит: непонятно, шестьдесят два это хорошо или
 * плохо и из чего оно складывается. Кружок с заливкой и цветом отвечает на это без
 * пояснений, а под названием категории написано, что она вообще значит: слова
 * «производительность» и «best practices» владельцу сайта тоже мало о чём говорят.
 *
 * Порог цвета взят у самого Lighthouse: до 50 красный, до 90 жёлтый, дальше зелёный.
 */
function toHtmlLighthouse(lighthouse) {
  if (!lighthouse?.available) return '';

  const categories = lighthouse.summary?.categories ?? [];
  if (!categories.length) return '';

  const rings = categories.map((item) => {
    const score = Number(item.score);
    const percent = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
    const color = percent >= 90 ? '#2fa86a' : percent >= 50 ? '#e0a92b' : '#d94a4a';
    const human = LIGHTHOUSE_HUMAN[item.id] ?? {};
    return `<div class="ring-card">
      <div class="ring" style="--p:${percent};--c:${color}" role="img" aria-label="${esc(human.title ?? item.title)}: ${percent} из 100"><i>${Number.isFinite(score) ? score : '-'}</i></div>
      <div><b>${esc(human.title ?? item.title)}</b><span>${esc(human.cost ?? '')}</span></div>
    </div>`;
  }).join('');

  // Метрики оставляем, но одной строкой и без оценок: это справка для того, кто в них
  // разбирается, а не то, по чему принимают решения.
  const metrics = (lighthouse.summary?.metrics ?? []).filter((m) => m.value);
  const metricsBlock = metrics.length
    ? `<details><summary>Замеры загрузки, если интересны подробности</summary>
        <ul>${metrics.map((m) => `<li>${esc(m.label)}: <b>${esc(m.value)}</b></li>`).join('')}</ul>
      </details>`
    : '';

  return `<h2>Скорость и техника</h2>
  <p class="sub" style="margin:0 0 12px">Замер сделан в настоящем браузере Chrome на профиле телефона: так же, как это видит поисковик.</p>
  <div class="rings">${rings}</div>
  ${metricsBlock}`;
}














function toHtmlSkippedUrls(skippedUrls) {
  if (!skippedUrls.length) return '';
  // Раньше здесь была строка и в том случае, когда пропускать было нечего. Отчёт сообщал
  // «служебные ссылки не встречались», то есть занимал место рассказом ни о чём.
  return `<details><summary>Почему проверено не всё: пропущено ${skippedUrls.length} служебных ${plural(skippedUrls.length, 'страница', 'страницы', 'страниц')}</summary>
    <p style="margin:10px 0 0">Это страницы, которые конструктор делает сам: политика, соглашение,
    оформление заказа, страница ошибки. Их SEO ни на что не влияет, а в отчёте они создавали
    десятки одинаковых замечаний и мешали увидеть настоящие проблемы.</p>
  </details>`;
}





function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function severityLabel(severity) {
  return {
    critical: 'Критично',
    recommended: 'Рекомендация',
    pass: 'ОК'
  }[severity] ?? severity;
}
