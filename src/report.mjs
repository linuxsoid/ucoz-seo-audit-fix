import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

export function toMarkdown(result) {
  const issues = result.checks.filter((check) => check.severity !== 'pass');
  const contentIssues = issues.filter((check) => !String(check.code).startsWith('lighthouse.'));
  const pageGroups = groupIssuesByPage(result, contentIssues);
  const templateGroups = groupIssuesByTemplate(result, contentIssues);
  const unitLabel = templateGroups.length && !pageGroups.length ? 'Проверено источников' : 'Проверено страниц';

  return `# SEO-отчёт

Сайт: ${result.startUrl}
Дата проверки: ${result.scannedAt}
${unitLabel}: ${result.pages.length}

## Сводка

| Метрика | Значение |
| --- | ---: |
| Критичные | ${result.summary.critical} |
| Рекомендации | ${result.summary.recommended} |
| Успешные проверки | ${result.summary.passed} |

## Типы замечаний

${formatIssueCounts(issues)}

## Публичные страницы

${formatPageGroups(pageGroups)}

## Шаблоны и источники

${formatTemplateGroups(templateGroups)}

## Lighthouse / производительность

${formatLighthouse(result.lighthouse)}

## Пропущенные служебные ссылки

${formatSkippedUrls(result.skippedUrls ?? [])}

## Политика безопасных исправлений

Автоматически исправляем только детерминированные изменения шаблонов и meta-тегов с backup и diff. Переписывание контента, выбор типа Schema.org, редиректы и canonical требуют подтверждения человека.
`;
}

export function toHtml(result) {
  const issues = result.checks.filter((check) => check.severity !== 'pass');
  const contentIssues = issues.filter((check) => !String(check.code).startsWith('lighthouse.'));
  const pageGroups = groupIssuesByPage(result, contentIssues);
  const templateGroups = groupIssuesByTemplate(result, contentIssues);
  const unitLabel = templateGroups.length && !pageGroups.length ? 'проверено источников' : 'проверено страниц';

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SEO-отчёт</title>
  <style>
    body{font-family:Inter,Segoe UI,Arial,sans-serif;margin:0;background:#f6f4ef;color:#1d2026}
    main{max-width:1180px;margin:auto;padding:28px}
    h1{margin:0 0 10px;font-size:32px}
    .summary{display:flex;gap:12px;margin:20px 0;flex-wrap:wrap}
    .metric{background:white;border:1px solid #ded8cf;border-radius:8px;padding:14px 16px;min-width:150px}
    .metric b{display:block;font-size:28px}
    .section{margin:26px 0}
    .group{background:white;border:1px solid #ded8cf;border-radius:8px;margin:12px 0;padding:16px}
    .group h3{margin:0 0 6px;font-size:18px}
    .url{font-size:12px;word-break:break-all;color:#5c6370}
    ul,ol{margin:10px 0;padding-left:22px;list-style-position:outside}
    li{padding-left:2px}
    .issues{display:grid;gap:8px;margin-top:12px}
    .issue{border-top:1px solid #ebe6de;padding-top:8px}
    .issue-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .code{font-family:ui-monospace,Consolas,monospace;background:#f0ede7;border-radius:6px;padding:3px 6px;font-size:12px}
    .counts{background:white;border:1px solid #ded8cf;border-radius:8px;padding:10px 16px;display:grid;gap:0}
    .count-row{display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #f0ede7}
    .count-row:last-child{border-bottom:0}
    .count-row b{min-width:38px;text-align:right}
    .lh-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0}
    .lh-score{background:white;border:1px solid #ded8cf;border-radius:8px;padding:12px}
    .lh-score b{display:block;font-size:24px}
    a{color:#205fcb}
    .sev{display:inline-block;border-radius:999px;padding:4px 8px;font-weight:700;font-size:11px}
    .critical{background:#ffe0e0;color:#a01717}
    .recommended{background:#fff0cc;color:#7b5200}
    .muted{color:#6f7480}
  </style>
</head>
<body>
  <main>
    <h1>SEO-отчёт</h1>
    <p>${esc(result.startUrl)} · ${esc(result.scannedAt)} · ${unitLabel}: ${result.pages.length}</p>
    <section class="summary">
      <div class="metric"><b>${result.summary.critical}</b>Критичные</div>
      <div class="metric"><b>${result.summary.recommended}</b>Рекомендации</div>
      <div class="metric"><b>${result.summary.passed}</b>Успешные проверки</div>
    </section>
    <section class="section">
      <h2>Типы замечаний</h2>
      ${toHtmlIssueCounts(issues)}
    </section>
    <section class="section">
      <h2>Публичные страницы</h2>
      ${toHtmlPageGroups(pageGroups)}
    </section>
    <section class="section">
      <h2>Шаблоны и источники</h2>
      ${toHtmlTemplateGroups(templateGroups)}
    </section>
    <section class="section">
      <h2>Lighthouse / производительность</h2>
      ${toHtmlLighthouse(result.lighthouse)}
    </section>
    <section class="section">
      <h2>Пропущенные служебные ссылки</h2>
      ${toHtmlSkippedUrls(result.skippedUrls ?? [])}
    </section>
  </main>
</body>
</html>`;
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

function toHtmlLighthouse(lighthouse) {
  if (!lighthouse) return '<p>Lighthouse не запускался для этого отчёта.</p>';
  if (!lighthouse.available) return `<p>Lighthouse не запущен: ${esc(lighthouse.message)}</p>`;

  const categories = lighthouse.summary.categories.length
    ? `<div class="lh-grid">${lighthouse.summary.categories.map((item) => `<div class="lh-score"><b>${esc(item.score ?? '-')}</b>${esc(item.title)}</div>`).join('')}</div>`
    : '<p>Оценки категорий не получены.</p>';
  const metrics = lighthouse.summary.metrics.length
    ? `<div class="counts">${lighthouse.summary.metrics.map((item) => `<div class="count-row"><b>${esc(item.score ?? '-')}</b><span>${esc(item.label)}:</span><span>${esc(item.value || '-')}</span></div>`).join('')}</div>`
    : '<p>Метрики не получены.</p>';
  const issues = lighthouse.summary.topIssues.length
    ? `<div class="issues">${lighthouse.summary.topIssues.map((item) => `<div class="issue"><div class="issue-head"><span class="sev ${esc(item.severity)}">${esc(severityLabel(item.severity))}</span><span class="code">lighthouse.${esc(item.id)}</span></div><p>${esc(item.message)}</p><p><b>Что сделать:</b> ${esc(item.fix)}</p></div>`).join('')}</div>`
    : '<p>Крупных рекомендаций Lighthouse не найдено.</p>';
  const files = lighthouse.reportFiles?.length ? `<p class="muted">Файлы Lighthouse: ${esc(lighthouse.reportFiles.join(', '))}</p>` : '';

  return `<article class="group"><h3>${esc(lighthouse.url)}</h3><div class="url">Профиль: ${esc(lighthouse.formFactor)}</div>${files}${categories}<h3>Метрики</h3>${metrics}<h3>Главные рекомендации</h3>${issues}</article>`;
}

function groupIssuesByPage(result, issues) {
  const pagesByUrl = new Map((result.pages ?? []).map((page) => [page.url, page]));
  const groups = new Map();
  for (const check of issues) {
    const page = pagesByUrl.get(check.url);
    if (page?.sourceType === 'template' || page?.sourceType === 'ftp_file' || page?.templateId) continue;
    const key = check.url;
    if (!groups.has(key)) {
      groups.set(key, {
        url: check.url,
        title: getPageTitle(page) || siteLevelTitle(check.url, result.origin),
        templateHint: inferTemplateForUrl(check.url, result.origin),
        checks: []
      });
    }
    groups.get(key).checks.push(check);
  }
  return sortGroups(groups);
}

function groupIssuesByTemplate(result, issues) {
  const pagesByUrl = new Map((result.pages ?? []).map((page) => [page.url, page]));
  const groups = new Map();
  for (const check of issues) {
    const page = pagesByUrl.get(check.url);
    if (!page || (!page.templateId && page.sourceType !== 'template' && page.sourceType !== 'ftp_file')) continue;
    const key = `${page.moduleId || '-'}:${page.templateId || page.url}`;
    if (!groups.has(key)) {
      groups.set(key, {
        title: page.templateName || page.name || page.url,
        moduleId: page.moduleId || '',
        templateId: page.templateId || '',
        sourceType: page.sourceType || '',
        adminUrl: page.adminUrl || '',
        checks: []
      });
    }
    groups.get(key).checks.push(check);
  }
  return sortGroups(groups);
}

function sortGroups(groups) {
  return [...groups.values()].sort((a, b) => scoreGroup(b) - scoreGroup(a) || String(a.title).localeCompare(String(b.title), 'ru'));
}

function scoreGroup(group) {
  return group.checks.filter((check) => check.severity === 'critical').length * 1000 + group.checks.length;
}

function formatIssueCounts(issues) {
  const counts = countByCode(issues);
  if (!counts.length) return 'Проблем не найдено.\n';
  return ['| Кол-во | Тип |', '| ---: | --- |', ...counts.map(([code, count]) => `| ${count} | \`${code}\` |`)].join('\n');
}

function formatPageGroups(groups) {
  if (!groups.length) return 'Проблем на публичных страницах не найдено.\n';
  return groups.map((group) => {
    const template = group.templateHint ? `\nГде править: ${group.templateHint.title} (${group.templateHint.ref})` : '';
    const lines = [`### ${group.title}`, '', `URL: ${group.url}${template}`, '', group.checks.map(formatCheck).join('\n\n')];
    return lines.join('\n');
  }).join('\n\n');
}

function formatTemplateGroups(groups) {
  if (!groups.length) return 'Проблем по HTML-шаблонам/файлам в этом отчёте нет.\n';
  return groups.map((group) => {
    const id = group.moduleId || group.templateId ? `module_id=${group.moduleId || '-'}, template_id=${group.templateId || '-'}` : group.sourceType;
    const admin = group.adminUrl ? `\nАдминка: ${group.adminUrl}` : '';
    return [`### ${group.title}`, '', `Источник: ${id}${admin}`, '', group.checks.map(formatCheck).join('\n\n')].join('\n');
  }).join('\n\n');
}

function formatCheck(check) {
  const related = check.relatedUrls?.length ? `\nЗатронутые URL: ${check.relatedUrls.join(', ')}` : '';
  const target = check.targetUrl ? `\nЦель ссылки: ${check.targetUrl}` : '';
  return `**${severityLabel(check.severity)}** · \`${check.code}\`\n\n${check.message}${target}${related}${check.fix ? `\nЧто сделать: ${check.fix}` : ''}`;
}

function formatSkippedUrls(skippedUrls) {
  if (!skippedUrls.length) return 'Служебные ссылки не встречались или не были пропущены.\n';
  return `Пропущено служебных ссылок: ${skippedUrls.length}. Они не включены в публичный SEO-аудит, чтобы не путать страницы редактирования с реальными страницами сайта.\n`;
}

function toHtmlIssueCounts(issues) {
  const counts = countByCode(issues);
  if (!counts.length) return '<p>Проблем не найдено.</p>';
  return `<div class="counts">${counts.map(([code, count]) => `<div class="count-row"><b>${count}</b><span>×</span><span class="code">${esc(code)}</span></div>`).join('')}</div>`;
}

function toHtmlPageGroups(groups) {
  if (!groups.length) return '<p>Проблем на публичных страницах не найдено.</p>';
  return groups.map((group) => {
    const template = group.templateHint ? `<div class="url">Где править: ${esc(group.templateHint.title)} (${esc(group.templateHint.ref)})</div>` : '';
    return `<article class="group"><h3>${esc(group.title)}</h3><div class="url"><a href="${esc(group.url)}">${esc(group.url)}</a></div>${template}<div class="issues">${group.checks.map(toHtmlCheck).join('')}</div></article>`;
  }).join('');
}

function toHtmlTemplateGroups(groups) {
  if (!groups.length) return '<p>Проблем по HTML-шаблонам/файлам в этом отчёте нет.</p>';
  return groups.map((group) => {
    const id = group.moduleId || group.templateId ? `module_id=${group.moduleId || '-'}, template_id=${group.templateId || '-'}` : group.sourceType;
    const admin = group.adminUrl ? `<div class="url">Админка: <a href="${esc(group.adminUrl)}">${esc(group.adminUrl)}</a></div>` : '';
    return `<article class="group"><h3>${esc(group.title)}</h3><div class="url">${esc(id)}</div>${admin}<div class="issues">${group.checks.map(toHtmlCheck).join('')}</div></article>`;
  }).join('');
}

function toHtmlCheck(check) {
  const related = check.relatedUrls?.length ? `<div class="muted">Затронутые URL: ${esc(check.relatedUrls.join(', '))}</div>` : '';
  const target = check.targetUrl ? `<div class="muted">Цель ссылки: ${esc(check.targetUrl)}</div>` : '';
  return `<div class="issue"><div class="issue-head"><span class="sev ${esc(check.severity)}">${esc(severityLabel(check.severity))}</span><span class="code">${esc(check.code)}</span></div><p>${esc(check.message)}</p>${target}${related}${check.fix ? `<p><b>Что сделать:</b> ${esc(check.fix)}</p>` : ''}</div>`;
}

function toHtmlSkippedUrls(skippedUrls) {
  if (!skippedUrls.length) return '<p>Служебные ссылки не встречались или не были пропущены.</p>';
  return `<p>Пропущено служебных ссылок: <b>${skippedUrls.length}</b>. Они не включены в публичный SEO-аудит, чтобы не путать страницы редактирования с реальными страницами сайта.</p>`;
}

function countByCode(issues) {
  const counts = new Map();
  for (const check of issues) counts.set(check.code, (counts.get(check.code) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function getPageTitle(page) {
  const html = page?.html ?? '';
  return html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
}

function siteLevelTitle(url, origin) {
  if (url === `${origin}/robots.txt`) return 'robots.txt';
  if (url === `${origin}/sitemap.xml`) return 'sitemap.xml';
  return 'Проверка сайта';
}

function inferTemplateForUrl(url, origin) {
  try {
    const parsed = new URL(url);
    if (parsed.href === `${origin}/robots.txt`) return { title: 'FTP-файл robots.txt', ref: 'ftp_tool:read/write /robots.txt' };
    if (parsed.href === `${origin}/sitemap.xml`) return { title: 'FTP-файл sitemap.xml', ref: 'ftp_tool:read/write /sitemap.xml' };
    if (parsed.pathname === '/' || /^\/index\/0-\d+$/i.test(parsed.pathname)) {
      return { title: 'Редактор страниц: Страницы сайта', ref: 'module_id=2, template_id=0' };
    }
    if (parsed.pathname === '/register') return { title: 'Пользователи: Страница регистрации пользователей', ref: 'module_id=4, template_id=2' };
    if (parsed.pathname.includes('/index/31-')) return null;
    if (parsed.pathname === '/shop' || parsed.pathname === '/shop/') return { title: 'Интернет-магазин: Главная страница магазина', ref: 'module_id=20, template_id=1' };
    if (parsed.pathname === '/shop/compare') return { title: 'Интернет-магазин: страница сравнения/служебная страница магазина', ref: 'module_id=20, template_id=17 или служебный шаблон магазина' };
    if (/^\/shop\/\d+\/(desc|spec|imgs|comm)\//i.test(parsed.pathname)) return { title: 'Интернет-магазин: Страница товара', ref: 'module_id=20, template_id=4' };
    if (parsed.pathname.startsWith('/shop/')) return { title: 'Интернет-магазин: Каталог товаров', ref: 'module_id=20, template_id=2' };
    return null;
  } catch {
    return null;
  }
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
