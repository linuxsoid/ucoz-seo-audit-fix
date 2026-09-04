import { lighthouseChecksFromResult, runLighthouseAudit } from './lighthouse-audit.mjs';

const USER_AGENT = 'Mozilla/5.0 (compatible; uCozSEOAuditFix/0.1; +https://api.ucoz.net/)';

export async function auditSite(startUrl, options = {}) {
  const maxPages = options.maxPages ?? 25;
  const origin = new URL(startUrl).origin;
  const queue = [normalizeUrl(startUrl)];
  const seen = new Set();
  const skippedUrls = [];
  const pages = [];

  const siteChecks = [...(await auditSiteFiles(origin)), ...(await auditTls(origin))];

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
          skippedUrls.push({
            href: link.href,
            foundOn: url,
            reason: isSystemPage(new URL(link.href, origin).pathname)
              ? 'Служебная страница движка: владелец её не редактирует, SEO-ценности нет.'
              : 'Служебная ссылка админки, к публичному SEO не относится.'
          });
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
  const siteWideChecks = auditSiteWide(pages, origin);
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
    ...siteWideChecks,
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
      // Запрет индексации может стоять не только в мета-теге, но и в заголовке ответа
      // X-Robots-Tag. Второй вариант коварнее: в исходнике страницы его не видно.
      xRobotsTag: response.headers.get('x-robots-tag') ?? '',
      // Конечный адрес после всех перенаправлений. Нужен, чтобы поймать цепочки.
      finalUrl: response.url || url,
      html
    };
  } catch (error) {
    // «Страницу не удалось загрузить: fetch failed» не говорит владельцу сайта ничего.
    // Чаще всего за этим стоит конкретная поломка, и её видно, если не идти по
    // перенаправлению, а посмотреть на него. Найдено на живом сайте клиента: страница
    // отвечала Location: // без домена. По такому адресу не пройдёт ни браузер, ни
    // поисковый робот, и по сообщению «fetch failed» об этом не догадаться.
    const explained = await explainFetchFailure(url);
    return {
      url,
      status: 0,
      ok: false,
      contentType: '',
      bytes: 0,
      ms: Date.now() - started,
      html: '',
      checks: [issue('critical', 'page.fetch_failed', url, explained?.message ?? `Страницу не удалось загрузить: ${error.message}`, explained?.fix ?? 'Проверьте хостинг, DNS, SSL или правила блокировки.')]
    };
  }
}

/**
 * Пытается объяснить, почему страница не загрузилась.
 *
 * Запрашиваем ещё раз, но перенаправлениям не следуем: тогда видно сам заголовок
 * Location, а не общий отказ клиента. Если объяснить не получилось, возвращаем null и
 * в отчёт идёт исходное сообщение.
 */
async function explainFetchFailure(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return null;
  }

  if (response.status < 300 || response.status >= 400) return null;

  const location = response.headers.get('location');
  if (!location) {
    return {
      message: `Страница отвечает перенаправлением ${response.status}, но не говорит куда: заголовок Location пустой.`,
      fix: 'Укажите в Location полный адрес назначения или уберите перенаправление.'
    };
  }

  try {
    new URL(location, url);
  } catch {
    return {
      message: `Страница перенаправляет на нерабочий адрес «${location}»: по нему не пройдут ни браузер, ни поисковый робот.`,
      fix: 'Укажите в заголовке Location полный адрес вида https://site.ru/stranica или путь от корня вида /stranica.'
    };
  }

  return null;
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
  const robotsMeta = getMeta(html, 'name', 'robots');

  // --- Индексируемость страницы ---
  // Самая дорогая ошибка в SEO: страница сделана хорошо, но закрыта от поиска.
  // Проверяем оба места, где может стоять запрет: мета-тег и заголовок ответа.
  const noindexSources = [];
  if (/noindex/i.test(robotsMeta || '')) noindexSources.push('мета-тег robots');
  if (/noindex/i.test(page.xRobotsTag || '')) noindexSources.push('заголовок X-Robots-Tag');
  if (noindexSources.length) {
    checks.push(issue('critical', 'index.noindex', page.url,
      `Страница закрыта от индексации (${noindexSources.join(' и ')}).`,
      'Уберите noindex, если страница должна быть в поиске.'));
  } else {
    checks.push(pass('index.indexable', page.url, 'Страница открыта для индексации.'));
  }

  // --- Цепочка редиректов ---
  // Каждое лишнее перенаправление теряет часть ссылочного веса и замедляет загрузку.
  if (page.finalUrl && normalizeForCompare(page.finalUrl) !== normalizeForCompare(page.url)) {
    checks.push(issue('recommended', 'links.redirected', page.url,
      `Адрес перенаправляет на ${page.finalUrl}`,
      'Ставьте в меню и ссылках сразу конечный адрес, чтобы не терять вес на перенаправлениях.'));
  }

  // --- Иерархия заголовков ---
  // Пропуск уровня (H2 сразу на H4) ломает структуру документа и мешает поиску
  // понять, что на странице главное.
  const headingSkips = findHeadingSkips(html);
  if (headingSkips.length) {
    checks.push(issue('recommended', 'content.heading_order', page.url,
      `Нарушена иерархия заголовков: ${headingSkips.slice(0, 3).join(', ')}.`,
      'Уровни должны идти по порядку, без пропусков: за H2 идёт H3, а не H4.'));
  }
  if (h1s.length > 1) {
    checks.push(issue('recommended', 'content.h1_multiple', page.url,
      `На странице ${h1s.length} заголовков H1.`,
      'Оставьте один H1: он должен отвечать, о чём именно эта страница.'));
  }

  // --- Хлебные крошки ---
  // Разметка BreadcrumbList выводит путь по сайту прямо в выдачу и помогает
  // поиску понять структуру. Проверяем только на внутренних страницах: на главной
  // крошки не нужны.
  if (!isHomePage(page.url)) {
    if (/BreadcrumbList/i.test(html)) {
      checks.push(pass('schema.breadcrumbs_ok', page.url, 'Есть разметка хлебных крошек.'));
    } else {
      checks.push(issue('recommended', 'schema.breadcrumbs_missing', page.url,
        'Нет разметки хлебных крошек BreadcrumbList.',
        'Добавьте крошки со Schema-разметкой: они показываются в выдаче и помогают навигации.'));
    }
  }

  if (!page.ok) checks.push(issue('critical', 'page.bad_status', page.url, `Страница возвращает HTTP ${page.status}.`, 'Исправьте ответ сервера или цепочку редиректов.'));
  else checks.push(pass('page.ok', page.url, `Страница возвращает HTTP ${page.status}.`));

  if (!title) checks.push(issue('critical', 'meta.title_missing', page.url, 'Отсутствует title.', 'Добавьте уникальный и понятный <title>.'));
  else if (title.length < 10 || title.length > 65) checks.push(issue('recommended', 'meta.title_length', page.url,
    // Показываем сам текст: без него человек видит «82 символа» и не понимает, что резать.
    `Длина title ${title.length} символов: «${title}»`, 'Ориентир: примерно 10-65 символов.', { value: title }));
  else checks.push(pass('meta.title_ok', page.url, 'Title заполнен.'));

  if (!description) checks.push(issue('critical', 'meta.description_missing', page.url, 'Отсутствует meta description.', 'Добавьте уникальное описание страницы.'));
  else if (description.length < 50 || description.length > 170) checks.push(issue('recommended', 'meta.description_length', page.url,
    `Длина description ${description.length} символов: «${description}»`, 'Ориентир: примерно 50-170 символов.', { value: description }));
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

/**
 * Проверка сертификата: жив ли HTTPS и сколько ему осталось.
 *
 * У владельцев сайтов на конструкторах это регулярная боль: сертификат тихо истекает,
 * браузер начинает пугать посетителя предупреждением, и трафик падает раньше, чем
 * человек узнаёт о проблеме.
 *
 * Срок действия берём из TLS-рукопожатия напрямую: HTTP-ответ его не содержит.
 */
async function auditTls(origin) {
  const checks = [];
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return checks;
  }

  if (parsed.protocol !== 'https:') {
    checks.push(issue('critical', 'tls.no_https', origin,
      'Сайт работает без HTTPS.',
      'Подключите SSL-сертификат: без него браузеры помечают сайт как небезопасный, а поиск понижает его.'));
    return checks;
  }

  try {
    const tls = await import('node:tls');
    const cert = await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: parsed.hostname, port: 443, servername: parsed.hostname, timeout: 8000 },
        () => {
          // true просит всю цепочку, а не только конечный сертификат: корень нужен,
          // чтобы понять, у всех ли клиентов он есть.
          const peer = socket.getPeerCertificate(true);
          const authorized = socket.authorized;
          socket.end();
          resolve({ peer, authorized });
        }
      );
      socket.on('error', reject);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('таймаут')); });
    });

    if (!cert.authorized) {
      checks.push(issue('critical', 'tls.not_trusted', origin,
        'Сертификат не проходит проверку доверия.',
        'Браузер покажет посетителю предупреждение. Перевыпустите сертификат.'));
      return checks;
    }

    const validTo = cert.peer?.valid_to ? new Date(cert.peer.valid_to) : null;
    if (validTo && !Number.isNaN(validTo.getTime())) {
      const daysLeft = Math.round((validTo - Date.now()) / 86400000);
      if (daysLeft < 0) {
        checks.push(issue('critical', 'tls.expired', origin,
          'Срок действия сертификата истёк.',
          'Перевыпустите сертификат немедленно: сайт открывается с предупреждением.'));
      } else if (daysLeft <= 14) {
        checks.push(issue('critical', 'tls.expiring', origin,
          `Сертификат истекает через ${daysLeft} дн.`,
          'Продлите сертификат до окончания срока, иначе сайт начнёт пугать посетителей.'));
      } else {
        checks.push(pass('tls.ok', origin, `HTTPS работает, сертификат действует ещё ${daysLeft} дн.`));
      }
    }

    checks.push(...auditCertChain(origin, cert.peer));
  } catch (error) {
    checks.push(issue('recommended', 'tls.check_failed', origin,
      `Не удалось проверить сертификат: ${error.message}`,
      'Проверьте вручную, открывается ли сайт по HTTPS без предупреждений.'));
  }

  return checks;
}

/**
 * Проверка корня цепочки сертификата.
 *
 * Зачем это отдельно от обычной проверки доверия. Наш сервер на Linux, и его хранилище
 * корневых сертификатов обновляется. Он говорит «сертификат доверенный», и формально он
 * прав. Но у посетителя может быть старая Windows, чьё хранилище новых корней ещё не
 * знает, и тот же самый сайт откроется у него с предупреждением на весь экран.
 *
 * Поймано на живом сайте: bubman.net. С нашего сервера сертификат проходит проверку без
 * замечаний, а Chrome на Windows отдаёт SEC_E_UNTRUSTED_ROOT и не открывает сайт вовсе.
 *
 * Причина в том, что Let’s Encrypt с 13 мая 2026 выдаёт сертификаты по новой иерархии
 * Generation Y с корнями ISRG Root YE и YR. В цепочке есть кросс-подпись на давно
 * известные ISRG Root X1 и X2, и большинство клиентов сами достроят доверенный путь.
 * Но те, кто достраивать не умеет, спотыкаются.
 *
 * Поэтому это рекомендация, а не критичное: у большинства посетителей всё откроется.
 * Но владельцу сайта надо знать, что часть аудитории видит предупреждение.
 */
function auditCertChain(origin, peer) {
  const checks = [];
  if (!peer) return checks;

  // Идём вверх по цепочке до самоподписанного, то есть до корня.
  const names = [];
  let node = peer;
  const seen = new Set();
  while (node && !seen.has(node.fingerprint)) {
    seen.add(node.fingerprint);
    const cn = node.subject?.CN || node.subject?.O || '';
    if (cn) names.push(cn);
    if (node.issuerCertificate === node) break;
    node = node.issuerCertificate;
  }
  if (!names.length) return checks;

  const chain = names.join(' <- ');

  // Ищем поколение Y по ВСЕЙ цепочке, а не по последнему звену.
  // На bubman.net цепочка выглядит так:
  //   bubman.net <- YE1 <- Root YE <- ISRG Root X2 <- ISRG Root X1
  // Последним стоит давно известный X1, и по нему всё выглядит идеально. Но клиент,
  // который не умеет искать альтернативный путь, останавливается на Root YE, которого
  // не знает, и показывает предупреждение. Значит важно само присутствие звена YE или YR.
  const GEN_Y = /^(ISRG )?Root Y[ER]$|^Y[ER]\d+$/;
  if (names.some((name) => GEN_Y.test(name))) {
    checks.push(issue('recommended', 'tls.new_root', origin,
      `В цепочке сертификата есть новый корень Let’s Encrypt поколения Y: ${chain}`,
      'Часть старых клиентов, особенно Windows без свежих обновлений, этот корень ещё не знает и покажет предупреждение. Убедитесь, что сервер отдаёт полную цепочку с кросс-подписью, и проверьте сайт на ssllabs.com.',
      { chain }));
  } else {
    checks.push(pass('tls.chain_ok', origin, `Цепочка сертификата: ${chain}`));
  }

  return checks;
}

/**
 * Проверки, которые имеют смысл только по сайту целиком, а не по одной странице.
 *
 * Контакты и счётчик аналитики достаточно найти хоть где-то: телефон обычно в шапке
 * или в подвале, а счётчик в общем шаблоне. Требовать их на каждой странице
 * бессмысленно и породило бы поток одинаковых замечаний.
 */
function auditSiteWide(pages, origin) {
  const checks = [];
  const htmlPages = pages.filter((page) => page.html);
  if (!htmlPages.length) return checks;

  const allHtml = htmlPages.map((page) => page.html).join('\n');

  // --- Контакты ---
  // Коммерческий фактор доверия: сайт без единого способа связи и поиск ранжирует
  // хуже, и посетитель закрывает.
  const hasPhone = /(?:href=["']tel:)|(?:\+7[\s(-]?\d{3}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2})/i.test(allHtml);
  const hasEmail = /href=["']mailto:/i.test(allHtml);
  const hasMessenger = /(?:wa\.me|t\.me|api\.whatsapp\.com|viber:)/i.test(allHtml);
  if (hasPhone || hasEmail || hasMessenger) {
    const found = [hasPhone && 'телефон', hasEmail && 'почта', hasMessenger && 'мессенджер']
      .filter(Boolean).join(', ');
    checks.push(pass('trust.contacts_ok', origin, `Контакты на сайте есть: ${found}.`));
  } else {
    checks.push(issue('recommended', 'trust.contacts_missing', origin,
      'На проверенных страницах не нашлось ни телефона, ни почты, ни мессенджера.',
      'Добавьте способ связи в шапку или подвал: без него падает и доверие посетителя, и позиции коммерческого сайта.'));
  }

  // --- Счётчик аналитики ---
  // Без счётчика владелец не видит ни трафика, ни поведения, и любые SEO-правки
  // делаются вслепую: нечем измерить, стало лучше или хуже.
  const counters = [];
  if (/mc\.yandex\.ru|ym\(\s*\d+/i.test(allHtml)) counters.push('Яндекс.Метрика');
  if (/googletagmanager\.com|gtag\(|google-analytics\.com/i.test(allHtml)) counters.push('Google Analytics');
  if (counters.length) {
    checks.push(pass('analytics.counter_ok', origin, `Счётчик установлен: ${counters.join(', ')}.`));
  } else {
    checks.push(issue('recommended', 'analytics.counter_missing', origin,
      'Счётчик аналитики не найден.',
      'Поставьте Яндекс.Метрику или Google Analytics: без них не видно, приносят ли правки результат.'));
  }

  // --- Осиротевшие страницы ---
  // Страница, на которую не ведёт ни одна внутренняя ссылка, для поиска почти не
  // существует: до неё не доходит ни краулер, ни вес остальных страниц.
  const linkedTo = new Set();
  for (const page of htmlPages) {
    for (const link of page.links ?? []) {
      if (link.internal) linkedTo.add(normalizeForCompare(link.href));
    }
  }
  const orphans = htmlPages
    .map((page) => page.url)
    .filter((url) => !isHomePage(url) && !linkedTo.has(normalizeForCompare(url)));
  if (orphans.length) {
    checks.push(issue('recommended', 'links.orphan_pages', orphans[0],
      `Найдены страницы без внутренних ссылок: ${orphans.length}.`,
      'Сошлитесь на них из меню или из текста других страниц, иначе поиск их почти не видит.',
      { pages: orphans.slice(0, 10) }));
  }

  // --- Глубина вложенности ---
  // Чем глубже страница, тем меньше веса до неё доходит. Три клика от главной это
  // общепринятый ориентир.
  const deep = htmlPages
    .map((page) => ({ url: page.url, depth: pathDepth(page.url) }))
    .filter((item) => item.depth > 3);
  if (deep.length) {
    checks.push(issue('recommended', 'links.deep_pages', deep[0].url,
      `Страниц глубже третьего уровня: ${deep.length}.`,
      'Сократите путь до важных страниц: ориентир это не больше трёх кликов от главной.',
      { pages: deep.slice(0, 10).map((item) => item.url) }));
  }

  return checks;
}

/** Пропуски уровней заголовков в порядке появления, например «H2 сразу на H4». */
function findHeadingSkips(html) {
  const levels = [...String(html).matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  const skips = [];
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) skips.push(`H${levels[i - 1]} сразу на H${levels[i]}`);
  }
  return [...new Set(skips)];
}

function isHomePage(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path === '' || path === '/index.html';
  } catch {
    return false;
  }
}

function pathDepth(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Сравниваем адреса без хвостового слэша и без якоря, иначе одна страница двоится. */
function normalizeForCompare(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return (parsed.origin + parsed.pathname.replace(/\/+$/, '') + parsed.search).toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
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

/**
 * Служебные адреса, которые не относятся к публичному SEO сайта.
 *
 * Делятся на два класса, и важно понимать разницу.
 *
 * Первый класс: ссылки админки и редактирования. Это вообще не страницы сайта,
 * посетитель их не видит, поисковик тоже.
 *
 * Второй класс: автогенерируемые страницы конструктора. Политика конфиденциальности,
 * пользовательское соглашение, оформление заказа, страница 404. Формально это
 * настоящие страницы, но владелец их не пишет и не редактирует, а SEO-ценности у них
 * нет. Поймано на живом сайте genomplus.ru: 18 замечаний из 20 висели ровно на двух
 * таких страницах, и человек видел пугающий счётчик вместо двух реальных проблем.
 * Считать их вместе с контентными страницами значит врать пользователю о масштабе.
 */
function isServiceUrl(url, origin) {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return false;

    // Админка и редактирование
    if (parsed.pathname.startsWith('/panel')) return true;
    if (parsed.pathname === '/admin') return true;
    if (/^\/index\/31-\d+-0-\d+-\d+$/i.test(parsed.pathname)) return true;
    if (/^\/index\/\d+-\d+-0-\d+-\d+$/i.test(parsed.pathname) && parsed.searchParams.has('edit')) return true;

    return isSystemPage(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Автогенерируемые страницы конструктора. У uKit они начинаются с двух подчёркиваний,
 * у uCoz встречаются привычные имена вроде /privacy или /404.html.
 */
function isSystemPage(pathname) {
  const path = String(pathname || '').toLowerCase();
  const last = path.replace(/\/+$/, '').split('/').pop() || '';

  // uKit генерирует их с префиксом __ , это самый надёжный признак
  if (last.startsWith('__')) return true;

  return SYSTEM_PAGE_NAMES.some((name) => last === name || last === name + '.html');
}

const SYSTEM_PAGE_NAMES = [
  'privacy', 'privacy-policy', 'privacy_policy', 'policy',
  'agreement', 'user-agreement', 'user_agreement', 'terms', 'oferta',
  'checkout', 'cart', 'order-success', 'order_success',
  '404', 'not-found'
];

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
