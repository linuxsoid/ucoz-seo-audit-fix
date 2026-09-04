import { lighthouseChecksFromResult, runLighthouseAudit } from './lighthouse-audit.mjs';

const USER_AGENT = 'Mozilla/5.0 (compatible; uCozSEOAuditFix/0.1; +https://api.ucoz.net/)';

export async function auditSite(startUrl, options = {}) {
  const maxPages = options.maxPages ?? 25;
  const origin = new URL(startUrl).origin;
  const queue = [normalizeUrl(startUrl)];
  const seen = new Set();
  const skippedUrls = [];
  const pages = [];

  const siteChecks = await auditSiteFiles(origin);

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const page = await fetchPage(url);
    pages.push(page);

    if (page.html) {
      const links = extractLinks(page.html, url);
      page.checks = auditHtml(page, links);
      page.links = links.slice(0, 200);

      for (const link of links) {
        if (pages.length + queue.length >= maxPages) break;
        if (isServiceUrl(link.href, origin)) {
          skippedUrls.push({ href: link.href, foundOn: url, reason: 'Служебная ссылка uCoz не относится к публичному SEO-аудиту.' });
          continue;
        }
        if (link.internal && link.crawlable && !seen.has(link.href) && !queue.includes(link.href)) {
          queue.push(link.href);
        }
      }
    }
  }

  const duplicateChecks = findDuplicates(pages);
  const brokenLinkChecks = await auditInternalLinks(pages);
  const lighthouse = options.lighthouse ? await runLighthouseAudit(startUrl, {
    categories: options.lighthouseCategories,
    formFactor: options.lighthouseFormFactor,
    output: options.lighthouseOutput
  }) : null;

  const allChecks = [
    ...siteChecks,
    ...pages.flatMap((page) => page.checks ?? []),
    ...duplicateChecks,
    ...brokenLinkChecks,
    ...lighthouseChecksFromResult(lighthouse)
  ];

  return {
    scannedAt: new Date().toISOString(),
    startUrl,
    origin,
    summary: summarize(allChecks),
    checks: allChecks,
    skippedUrls: dedupeSkipped(skippedUrls),
    lighthouse,
    pages
  };
}

export function auditHtmlBundle(items, options = {}) {
  const pages = [];

  for (const item of items ?? []) {
    const html = String(item.html ?? '');
    const url = item.url || item.name || 'template';
    const baseUrl = item.baseUrl || options.baseUrl || 'https://example.ucoz.net/';
    const links = extractLinks(html, baseUrl);
    const page = {
      url,
      name: item.name ?? url,
      moduleId: item.moduleId ?? item.module_id ?? '',
      templateId: item.templateId ?? item.template_id ?? '',
      templateName: item.templateName ?? item.name ?? '',
      adminUrl: item.adminUrl ?? '',
      sourceType: item.sourceType ?? 'template',
      status: 200,
      ok: true,
      contentType: 'text/html',
      bytes: html.length,
      ms: 0,
      html,
      links: links.slice(0, 200)
    };
    page.checks = auditHtml(page, links);
    pages.push(page);
  }

  const duplicateChecks = findDuplicates(pages);
  const allChecks = [
    ...pages.flatMap((page) => page.checks ?? []),
    ...duplicateChecks
  ];

  return {
    scannedAt: new Date().toISOString(),
    startUrl: options.baseUrl ?? '',
    origin: options.baseUrl ? new URL(options.baseUrl).origin : '',
    summary: summarize(allChecks),
    checks: allChecks,
    pages
  };
}

async function fetchPage(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    const contentType = response.headers.get('content-type') ?? '';
    const html = contentType.includes('text/html') ? await response.text() : '';
    return {
      url,
      status: response.status,
      ok: response.ok,
      contentType,
      bytes: html.length,
      ms: Date.now() - started,
      html
    };
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      contentType: '',
      bytes: 0,
      ms: Date.now() - started,
      html: '',
      checks: [issue('critical', 'page.fetch_failed', url, `Страницу не удалось загрузить: ${error.message}`, 'Проверьте хостинг, DNS, SSL или правила блокировки.')]
    };
  }
}

async function auditSiteFiles(origin) {
  const checks = [];
  const robots = await fetchText(`${origin}/robots.txt`);
  if (!robots.ok) {
    checks.push(issue('recommended', 'site.robots_missing', origin, 'robots.txt отсутствует или недоступен.', 'Добавьте robots.txt со ссылкой на sitemap.xml.'));
  } else {
    checks.push(pass('site.robots_found', origin, 'robots.txt доступен.'));
    if (!/sitemap:/i.test(robots.text)) {
      checks.push(issue('recommended', 'site.robots_no_sitemap', `${origin}/robots.txt`, 'В robots.txt нет ссылки на sitemap.xml.', 'Добавьте директиву Sitemap.'));
    }
    if (/disallow:\s*\/\s*$/im.test(robots.text)) {
      checks.push(issue('critical', 'site.robots_blocks_all', `${origin}/robots.txt`, 'robots.txt, похоже, закрывает от индексации весь сайт.', 'Проверьте Disallow: / перед продвижением сайта.'));
    }
  }

  const sitemap = await fetchText(`${origin}/sitemap.xml`);
  if (!sitemap.ok) {
    checks.push(issue('recommended', 'site.sitemap_missing', origin, 'sitemap.xml отсутствует или недоступен.', 'Сгенерируйте и опубликуйте sitemap.xml.'));
  } else {
    checks.push(pass('site.sitemap_found', origin, 'sitemap.xml доступен.'));
  }

  return checks;
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(10000)
    });
    return { ok: response.ok, status: response.status, text: response.ok ? await response.text() : '' };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

function auditHtml(page, links) {
  const html = page.html;
  const checks = [];
  const title = textOfFirstTag(html, 'title');
  const description = getMeta(html, 'name', 'description');
  const h1s = textOfTags(html, 'h1');
  const canonical = getLinkRel(html, 'canonical');
  const lang = getHtmlLang(html);
  const jsonLd = getJsonLdBlocks(html);

  if (!page.ok) checks.push(issue('critical', 'page.bad_status', page.url, `Страница возвращает HTTP ${page.status}.`, 'Исправьте ответ сервера или цепочку редиректов.'));
  else checks.push(pass('page.ok', page.url, `Страница возвращает HTTP ${page.status}.`));

  if (!title) checks.push(issue('critical', 'meta.title_missing', page.url, 'Отсутствует title.', 'Добавьте уникальный и понятный <title>.'));
  else if (title.length < 10 || title.length > 65) checks.push(issue('recommended', 'meta.title_length', page.url, `Длина title: ${title.length} символов.`, 'Ориентир: примерно 10-65 символов.'));
  else checks.push(pass('meta.title_ok', page.url, 'Title заполнен.'));

  if (!description) checks.push(issue('critical', 'meta.description_missing', page.url, 'Отсутствует meta description.', 'Добавьте уникальное описание страницы.'));
  else if (description.length < 50 || description.length > 170) checks.push(issue('recommended', 'meta.description_length', page.url, `Длина description: ${description.length} символов.`, 'Ориентир: примерно 50-170 символов.'));
  else checks.push(pass('meta.description_ok', page.url, 'Meta description заполнен.'));

  if (!h1s.length) checks.push(issue('recommended', 'content.h1_missing', page.url, 'Отсутствует H1.', 'Добавьте один понятный заголовок H1.'));
  else if (h1s.length > 1) checks.push(issue('recommended', 'content.h1_multiple', page.url, `Найдено H1: ${h1s.length}.`, 'По возможности оставьте один основной H1.'));
  else checks.push(pass('content.h1_ok', page.url, 'На странице есть один H1.'));

  if (!lang) checks.push(issue('recommended', 'html.lang_missing', page.url, 'У тега html отсутствует атрибут lang.', 'Добавьте lang в тег <html>.'));
  if (!getMeta(html, 'name', 'viewport')) checks.push(issue('critical', 'meta.viewport_missing', page.url, 'Отсутствует meta viewport.', 'Добавьте responsive viewport meta.'));
  if (!canonical) checks.push(issue('recommended', 'meta.canonical_missing', page.url, 'Отсутствует canonical-ссылка.', 'Добавьте canonical URL, если страница может дублироваться.'));

  for (const property of ['og:title', 'og:description', 'og:type', 'og:url']) {
    if (!getMeta(html, 'property', property)) checks.push(issue('recommended', `og.${property.replace(':', '_')}_missing`, page.url, `Отсутствует ${property}.`, 'Добавьте Open Graph метаданные.'));
  }
  if (!getMeta(html, 'name', 'twitter:card')) checks.push(issue('recommended', 'twitter.card_missing', page.url, 'Отсутствует twitter:card.', 'Добавьте Twitter Card метаданные.'));

  const imagesWithoutAlt = countImagesWithoutAlt(html);
  if (imagesWithoutAlt) checks.push(issue('recommended', 'images.alt_missing', page.url, `У изображений без alt: ${imagesWithoutAlt}.`, 'Добавьте полезный alt для значимых изображений.'));

  if (!jsonLd.length) {
    checks.push(issue('recommended', 'schema.jsonld_missing', page.url, 'Отсутствует структурированная разметка JSON-LD.', 'Добавьте Schema.org разметку WebSite, Organization, Article, Product или BreadcrumbList там, где это уместно.'));
  } else {
    for (const block of jsonLd) {
      try {
        JSON.parse(block);
      } catch (error) {
        checks.push(issue('critical', 'schema.jsonld_invalid', page.url, `Некорректный JSON-LD: ${error.message}`, 'Исправьте синтаксис JSON в структурированной разметке.'));
      }
    }
  }

  const crawlableInternal = links.filter((link) => link.internal && link.crawlable).length;
  if (!crawlableInternal) checks.push(issue('recommended', 'links.internal_missing', page.url, 'Не найдено внутренних ссылок, доступных для обхода.', 'Добавьте внутренние ссылки на важные страницы.'));

  return checks;
}

function findDuplicates(pages) {
  const checks = [];
  for (const [kind, reader] of [
    ['title', (page) => textOfFirstTag(page.html, 'title')],
    ['description', (page) => getMeta(page.html, 'name', 'description')]
  ]) {
    const groups = new Map();
    for (const page of pages) {
      const value = normalizeWhitespace(reader(page));
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(page.url);
    }
    for (const [value, urls] of groups) {
      if (urls.length > 1) {
        checks.push(issue('critical', `meta.${kind}_duplicate`, urls[0], `Дублируется ${kind} на ${urls.length} страницах: "${value.slice(0, 100)}"`, `Сделайте ${kind} уникальным для каждой страницы.`, { relatedUrls: urls }));
      }
    }
  }
  return checks;
}

async function auditInternalLinks(pages) {
  const unique = new Map();
  for (const page of pages) {
    for (const link of page.links ?? []) {
      if (link.internal && link.crawlable && !link.service && !unique.has(link.href)) unique.set(link.href, page.url);
    }
  }

  const checks = [];
  const targets = [...unique.keys()].slice(0, 100);
  await Promise.all(targets.map(async (href) => {
    const result = await headOrGet(href);
    if (result.status >= 400) {
      checks.push(issue('critical', 'links.internal_broken', unique.get(href), `Битая внутренняя ссылка: ${href} вернула ${result.status || 'нет ответа'}.`, 'Исправьте или удалите ссылку.', { targetUrl: href }));
    } else if (result.status === 0) {
      checks.push(issue('recommended', 'links.internal_unverified', unique.get(href), `Внутреннюю ссылку не удалось проверить: ${href}.`, 'Перепроверьте вручную или увеличьте таймаут перед изменением ссылки.', { targetUrl: href }));
    }
  }));
  return checks;
}

async function headOrGet(url) {
  try {
    let response = await fetch(url, { method: 'HEAD', headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (response.status === 405 || response.status === 403) {
      response = await getForLinkCheck(url);
    }
    return { status: response.status };
  } catch {
    try {
      const response = await getForLinkCheck(url);
      return { status: response.status };
    } catch {
      return { status: 0 };
    }
  }
}

function getForLinkCheck(url) {
  return fetch(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
}

function extractLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const raw = decodeHtml(match[1]).trim();
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) continue;
    try {
      const url = new URL(raw, baseUrl);
      url.hash = '';
      const href = normalizeUrl(url.href);
      links.push({
        href,
        text: normalizeWhitespace(stripTags(match[0])),
        internal: url.origin === new URL(baseUrl).origin,
        crawlable: /^https?:$/.test(url.protocol),
        service: isServiceUrl(href, new URL(baseUrl).origin)
      });
    } catch {
      links.push({ href: raw, text: '', internal: false, crawlable: false });
    }
  }
  return links;
}

function summarize(checks) {
  return {
    critical: checks.filter((check) => check.severity === 'critical').length,
    recommended: checks.filter((check) => check.severity === 'recommended').length,
    passed: checks.filter((check) => check.severity === 'pass').length
  };
}

function issue(severity, code, url, message, fix, extra = {}) {
  return { severity, code, url, message, fix, ...extra };
}

function pass(code, url, message) {
  return { severity: 'pass', code, url, message };
}

function textOfFirstTag(html, tag) {
  return normalizeWhitespace((html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')) ?? [])[1] ?? '');
}

function textOfTags(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((match) => normalizeWhitespace(stripTags(match[1]))).filter(Boolean);
}

function getMeta(html, attr, value) {
  const tag = findTag(html, 'meta', attr, value);
  return tag ? decodeHtml(getAttr(tag, 'content') ?? '') : '';
}

function getLinkRel(html, rel) {
  const tag = findTag(html, 'link', 'rel', rel);
  return tag ? decodeHtml(getAttr(tag, 'href') ?? '') : '';
}

function findTag(html, tagName, attr, value) {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? [];
  return tags.find((tag) => String(getAttr(tag, attr)).toLowerCase() === value.toLowerCase());
}

function getAttr(tag, attr) {
  const match = tag.match(new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function getHtmlLang(html) {
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  return getAttr(htmlTag, 'lang') ?? '';
}

function getJsonLdBlocks(html) {
  return [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1].trim());
}

function countImagesWithoutAlt(html) {
  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  return images.filter((tag) => !/\salt\s*=/i.test(tag)).length;
}

function stripTags(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ');
}

function normalizeWhitespace(value) {
  return decodeHtml(stripTags(value)).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.href;
}

function isServiceUrl(url, origin) {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return false;
    if (parsed.pathname.startsWith('/panel')) return true;
    if (parsed.pathname === '/admin') return true;
    if (/^\/index\/31-\d+-0-\d+-\d+$/i.test(parsed.pathname)) return true;
    if (/^\/index\/\d+-\d+-0-\d+-\d+$/i.test(parsed.pathname) && parsed.searchParams.has('edit')) return true;
    return false;
  } catch {
    return false;
  }
}

function dedupeSkipped(skippedUrls) {
  const seen = new Set();
  const result = [];
  for (const item of skippedUrls) {
    const key = `${item.href}|${item.foundOn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
