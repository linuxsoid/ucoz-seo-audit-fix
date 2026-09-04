/**
 * Отчёт для ИИ-агента и английские подписи проверок.
 *
 * Зачем отдельный формат. Человеку нужен текст: заголовки, объяснения, вежливые
 * формулировки. Агенту всё это мешает. Ему нужен короткий детерминированный документ,
 * где каждая проблема названа машинным кодом, перечислены точные адреса и сразу сказано,
 * что с этим делать через официальный uCoz MCP. Тогда владелец сайта просто отдаёт файл
 * своему агенту в Codex, Cursor или Claude и получает правки, не пересказывая ничего
 * своими словами.
 *
 * Почему markdown, а не JSON. JSON агенту тоже годится, он есть отдельной кнопкой. Но
 * markdown читает и человек, и модель, его можно вставить в чат целиком, и он не ломается
 * от обрезки. Для сценария «скачал и кинул агенту» это удобнее.
 *
 * Про язык. Сообщения проверок в движке написаны по-русски: сервис делается для
 * русскоязычных владельцев сайтов. Английская версия собирается не переводом текста на
 * лету, а по таблице подписей: у каждой проверки есть постоянный код, и к нему привязана
 * английская формулировка. Так перевод не плывёт от прогона к прогону, а коды остаются
 * теми же и в русской, и в английской версии.
 */

/**
 * Английские подписи и рекомендации по коду проверки.
 * Ключ это код проверки, он же используется в отчёте как машинный идентификатор.
 */
const EN = {
  'page.bad_status': ['Page returns an error status', 'Fix the server response or the redirect chain.'],
  'page.fetch_failed': ['Page could not be fetched', 'Check hosting, DNS, SSL or blocking rules.'],
  'page.ok': ['Page responds normally', ''],

  'meta.title_missing': ['Missing <title>', 'Add a unique, descriptive title.'],
  'meta.title_length': ['Title length outside the usual range', 'Aim for roughly 10 to 65 characters.'],
  'meta.title_ok': ['Title present', ''],
  'meta.description_missing': ['Missing meta description', 'Add a unique page description.'],
  'meta.description_length': ['Description length outside the usual range', 'Aim for roughly 50 to 170 characters.'],
  'meta.description_ok': ['Meta description present', ''],
  'meta.canonical_missing': ['Missing canonical link', 'Add a canonical URL if the page can be duplicated.'],
  'meta.viewport_missing': ['Missing viewport meta tag', 'Add the viewport meta tag, otherwise mobile rendering breaks.'],

  'html.lang_missing': ['Missing lang attribute on <html>', 'Declare the page language.'],

  'content.h1_missing': ['Missing H1', 'Add one clear H1 heading.'],
  'content.h1_multiple': ['More than one H1 on the page', 'Keep a single H1 that states what the page is about.'],
  'content.heading_order': ['Heading levels skip a step', 'Headings must go in order: H3 after H2, not H4.'],

  'images.alt_missing': ['Images without alt text', 'Describe every meaningful image in its alt attribute.'],

  'og.og_title_missing': ['Missing og:title', 'Add Open Graph metadata.'],
  'og.og_description_missing': ['Missing og:description', 'Add Open Graph metadata.'],
  'og.og_type_missing': ['Missing og:type', 'Add Open Graph metadata.'],
  'og.og_url_missing': ['Missing og:url', 'Add Open Graph metadata.'],
  'twitter.card_missing': ['Missing twitter:card', 'Add Twitter Card metadata.'],

  'schema.jsonld_missing': ['No JSON-LD structured data', 'Add Schema.org markup where it fits: WebSite, Organization, Product, FAQ.'],
  'schema.jsonld_invalid': ['JSON-LD block does not parse', 'Fix the JSON syntax, otherwise search engines ignore the block.'],
  'schema.breadcrumbs_missing': ['No BreadcrumbList markup', 'Add breadcrumbs with Schema markup: they show up in search results.'],
  'schema.breadcrumbs_ok': ['Breadcrumb markup present', ''],

  'links.internal_broken': ['Broken internal link', 'Fix or remove the link.'],
  'links.internal_missing': ['Internal link target is missing', 'Fix or remove the link.'],
  'links.internal_unverified': ['Internal link could not be verified', 'Check the link manually.'],
  'links.redirected': ['URL redirects to another address', 'Link directly to the final URL to avoid losing link equity.'],
  'links.orphan_pages': ['Pages with no incoming internal links', 'Link to them from the menu or from body text.'],
  'links.deep_pages': ['Pages deeper than three clicks from home', 'Shorten the path to important pages.'],

  'site.robots_missing': ['robots.txt is missing', 'Publish robots.txt.'],
  'site.robots_found': ['robots.txt found', ''],
  'site.robots_no_sitemap': ['robots.txt has no Sitemap directive', 'Add a Sitemap line pointing to sitemap.xml.'],
  'site.robots_blocks_all': ['SITE IS BLOCKED FROM SEARCH ENGINES in robots.txt', 'Remove Disallow: / first. No other fix matters while the site is not indexable.'],
  'site.sitemap_missing': ['sitemap.xml is missing or unreachable', 'Generate and publish sitemap.xml.'],
  'site.sitemap_found': ['sitemap.xml found', ''],

  'index.noindex': ['Page is closed from indexing', 'Remove noindex if the page should appear in search.'],
  'index.indexable': ['Page is open for indexing', ''],

  'tls.no_https': ['Site runs without HTTPS', 'Install an SSL certificate.'],
  'tls.not_trusted': ['Certificate is not trusted', 'Reissue the certificate: visitors see a browser warning.'],
  'tls.expired': ['Certificate has expired', 'Reissue immediately.'],
  'tls.expiring': ['Certificate expires soon', 'Renew before it lapses.'],
  'tls.ok': ['HTTPS works, certificate valid', ''],
  'tls.check_failed': ['Certificate could not be checked', 'Verify manually that the site opens over HTTPS without warnings.'],
  'tls.new_root': ['Certificate chain uses a new Let’s Encrypt root (Generation Y)',
    'Some older clients, notably Windows without recent updates, do not know this root yet and will show a warning. Make sure the server serves the full cross-signed chain and check the site on ssllabs.com.'],
  'tls.chain_ok': ['Certificate chain is fine', ''],

  'trust.contacts_missing': ['No phone, email or messenger found on the site', 'Add a way to get in touch in the header or footer.'],
  'trust.contacts_ok': ['Contact details present', ''],

  'analytics.counter_missing': ['No analytics counter found', 'Install Yandex.Metrica or Google Analytics.'],
  'analytics.counter_ok': ['Analytics counter installed', '']
};

/** Русские подписи берём из самой проверки: движок уже пишет их по-русски. */
function labelFor(check, lang) {
  if (lang !== 'en') return [check.message, check.fix ?? ''];

  const known = EN[check.code];
  if (known) return known;

  // Проверки Lighthouse несут английский оригинал рядом с нашим русским текстом:
  // список аудитов Lighthouse огромен и меняется от версии к версии, держать его копию
  // у себя бессмысленно, а сам Lighthouse формулировки уже даёт.
  if (check.messageEn) return [check.messageEn, check.fixEn ?? ''];

  // Совсем незнакомый код отдаём как есть: лучше одна русская строка в английском
  // отчёте, чем потерянная находка.
  return [check.message, check.fix ?? ''];
}

const T = {
  ru: {
    title: 'SEO-аудит для агента',
    site: 'Сайт', scanned: 'Проверено', pages: 'Страниц', generated: 'Дата проверки',
    howto: 'Как этим пользоваться',
    howtoBody: [
      'Этот файл рассчитан на ИИ-агента. Отдайте его агенту в Codex, Cursor или Claude вместе с подключённым официальным uCoz MCP.',
      'Каждая проблема имеет постоянный код, список затронутых адресов и рекомендацию.',
      'Правки в шаблоны вносит официальный ucoz-mcp: read_template, patch_template, ftp_tool. Перед записью делайте backup и показывайте diff.',
      'Не меняйте canonical, редиректы, robots.txt и Schema.org без подтверждения владельца.'
    ],
    blocker: 'БЛОКЕР',
    critical: 'Критичные', recommended: 'Рекомендации', passed: 'Пройдено',
    affected: 'Затронутые адреса', fix: 'Что сделать', skipped: 'Служебные страницы движка пропущены',
    skippedNote: 'Политика, соглашение, оформление заказа, страница 404 и прочие автогенерируемые страницы. Владелец их не редактирует, SEO-ценности нет.',
    none: 'Проблем по текущему набору проверок не найдено.'
  },
  en: {
    title: 'SEO audit for an agent',
    site: 'Site', scanned: 'Checked', pages: 'Pages', generated: 'Scanned at',
    howto: 'How to use this file',
    howtoBody: [
      'This file is written for an AI agent. Hand it to your agent in Codex, Cursor or Claude together with the official uCoz MCP connected.',
      'Every issue has a stable code, the list of affected URLs and a recommendation.',
      'Template edits go through the official ucoz-mcp: read_template, patch_template, ftp_tool. Back up and show a diff before writing.',
      'Do not change canonical, redirects, robots.txt or Schema.org without the owner confirming.'
    ],
    blocker: 'BLOCKER',
    critical: 'Critical', recommended: 'Recommended', passed: 'Passed',
    affected: 'Affected URLs', fix: 'What to do', skipped: 'Engine service pages skipped',
    skippedNote: 'Privacy policy, user agreement, checkout, 404 and other auto-generated pages. The owner does not edit them and they carry no SEO value.',
    none: 'No issues found for the current set of checks.'
  }
};

/**
 * Собирает markdown-отчёт для агента.
 * @param {object} result полный результат auditSite
 * @param {{lang?: 'ru'|'en'}} options
 */
export function toAgentMarkdown(result, options = {}) {
  const lang = options.lang === 'en' ? 'en' : 'ru';
  const t = T[lang];
  const checks = result.checks ?? [];
  const issues = checks.filter((check) => check.severity !== 'pass');

  // Группируем по коду: тридцать одинаковых строк агенту так же бесполезны,
  // как и человеку, а список адресов внутри группы он разберёт сам.
  const groups = new Map();
  for (const issue of issues) {
    const entry = groups.get(issue.code) ?? { code: issue.code, severity: issue.severity, urls: [], sample: issue };
    if (issue.severity === 'critical') entry.severity = 'critical';
    if (issue.url && !entry.urls.includes(issue.url)) entry.urls.push(issue.url);
    groups.set(issue.code, entry);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return b.urls.length - a.urls.length;
  });

  const lines = [];
  lines.push(`# ${t.title}`);
  lines.push('');
  lines.push(`- ${t.site}: ${result.startUrl}`);
  lines.push(`- ${t.generated}: ${result.scannedAt}`);
  lines.push(`- ${t.pages}: ${(result.pages ?? []).length}`);
  lines.push(`- ${t.critical}: ${result.summary?.critical ?? 0}, ${t.recommended}: ${result.summary?.recommended ?? 0}, ${t.passed}: ${result.summary?.passed ?? 0}`);
  lines.push('');

  lines.push(`## ${t.howto}`);
  lines.push('');
  for (const line of t.howtoBody) lines.push(`- ${line}`);
  lines.push('');

  // Блокер выносим наверх отдельно: пока сайт закрыт от поиска, остальные правки
  // не дают эффекта, и агент должен увидеть это первым.
  const blocker = ordered.find((group) => group.code === 'site.robots_blocks_all');
  if (blocker) {
    const [label, fix] = labelFor(blocker.sample, lang);
    lines.push(`## ${t.blocker}: \`${blocker.code}\``);
    lines.push('');
    lines.push(label);
    if (fix) lines.push('', `${t.fix}: ${fix}`);
    lines.push('');
  }

  if (!ordered.length) {
    lines.push(t.none);
  }

  for (const group of ordered) {
    if (group === blocker) continue;
    const [label, fix] = labelFor(group.sample, lang);
    const mark = group.severity === 'critical' ? t.critical : t.recommended;
    lines.push(`## \`${group.code}\` (${mark})`);
    lines.push('');
    lines.push(label);
    if (fix) lines.push('', `${t.fix}: ${fix}`);
    if (group.urls.length) {
      lines.push('', `${t.affected} (${group.urls.length}):`);
      for (const url of group.urls.slice(0, 50)) lines.push(`- ${url}`);
    }
    lines.push('');
  }

  const skipped = result.skippedUrls ?? [];
  if (skipped.length) {
    lines.push(`## ${t.skipped}: ${skipped.length}`);
    lines.push('');
    lines.push(t.skippedNote);
    lines.push('');
    for (const item of skipped.slice(0, 30)) lines.push(`- ${item.href}`);
    lines.push('');
  }

  return lines.join('\n');
}
