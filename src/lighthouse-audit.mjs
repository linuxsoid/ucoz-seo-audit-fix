import { mkdir, writeFile } from 'node:fs/promises';
import { withBrowserSlot } from './browser-slot.mjs';
import { killChrome, CHROME_FLAGS, chromeMemoryCheck } from './chrome-cleanup.mjs';
import { join, resolve } from 'node:path';

const CATEGORY_LABELS = {
  performance: 'Производительность',
  accessibility: 'Доступность',
  'best-practices': 'Best Practices',
  seo: 'SEO',
  pwa: 'PWA'
};

const METRIC_LABELS = {
  'first-contentful-paint': 'Первый контентный рендер (FCP)',
  'largest-contentful-paint': 'Крупнейший элемент первого экрана (LCP)',
  'total-blocking-time': 'Блокировка основного потока (TBT)',
  'cumulative-layout-shift': 'Сдвиг макета (CLS)',
  'speed-index': 'Индекс скорости',
  interactive: 'Время до интерактивности',
  'server-response-time': 'Ответ сервера',
  'total-byte-weight': 'Вес страницы'
};

const AUDIT_LABELS = {
  'unused-javascript': 'Лишний JavaScript',
  'unminified-javascript': 'JavaScript не минифицирован',
  'unminified-css': 'CSS не минифицирован',
  'unused-css-rules': 'Лишний CSS',
  'render-blocking-resources': 'Ресурсы блокируют первый рендер',
  'modern-image-formats': 'Изображения можно сжать современными форматами',
  'uses-optimized-images': 'Изображения можно оптимизировать',
  'uses-responsive-images': 'Нужны адаптивные изображения',
  'offscreen-images': 'Изображения вне первого экрана загружаются слишком рано',
  'uses-text-compression': 'Не включено текстовое сжатие',
  'server-response-time': 'Медленный ответ сервера',
  redirects: 'Лишние редиректы',
  'uses-long-cache-ttl': 'Короткий срок кеширования',
  'cache-insight': 'Неэффективное кеширование',
  'image-size-responsive': 'Размеры изображений не соответствуют контейнеру',
  'unsized-images': 'У изображений не заданы размеры',
  'third-party-summary': 'Влияние сторонних скриптов',
  'font-display': 'Шрифты могут блокировать отображение текста',
  'layout-shifts': 'Сдвиги макета',
  'network-dependency-tree-insight': 'Цепочка сетевых зависимостей',
  'lcp-discovery-insight': 'Обнаружение LCP-ресурса',
  'lcp-phases-insight': 'Фазы загрузки LCP',
  'lcp-breakdown-insight': 'Разбор LCP',
  'cls-culprits-insight': 'Причины сдвигов макета',
  'document-latency-insight': 'Задержка HTML-документа',
  'render-blocking-insight': 'Ресурсы блокируют рендеринг',
  'font-display-insight': 'Отображение шрифтов',
  'image-delivery-insight': 'Доставка изображений',
  'first-contentful-paint': 'Первый контентный рендер',
  'largest-contentful-paint': 'Крупнейший элемент первого экрана',
  'speed-index': 'Индекс скорости',
  'viewport': 'Viewport',
  'largest-contentful-paint-element': 'Элемент LCP требует внимания',
  'document-title': 'Проблема с title',
  'meta-description': 'Проблема с meta description',
  'http-status-code': 'Проблема с HTTP-статусом',
  'crawlable-anchors': 'Ссылки не всегда доступны поисковым роботам',
  'is-crawlable': 'Страница может быть закрыта от индексации',
  'robots-txt': 'Проблема в robots.txt',
  'hreflang': 'Проблема с hreflang',
  canonical: 'Проблема с canonical'
};

const AUDIT_FIXES = {
  'unused-javascript': 'Уберите неиспользуемые скрипты, отложите необязательные виджеты и проверьте, какие JS-файлы подключаются в глобальных шаблонах.',
  'unminified-javascript': 'Подключайте минифицированные JS-файлы или минифицируйте пользовательские скрипты перед загрузкой на FTP.',
  'unminified-css': 'Подключайте минифицированные CSS-файлы или минифицируйте пользовательские стили перед загрузкой на FTP.',
  'unused-css-rules': 'Разделите глобальные стили и стили отдельных модулей, чтобы не грузить лишний CSS на каждой странице.',
  'render-blocking-resources': 'Перенесите некритичные CSS/JS ниже, добавьте defer для безопасных скриптов и оставьте в head только то, что нужно для первого экрана.',
  'modern-image-formats': 'Сожмите крупные изображения и используйте WebP/AVIF там, где это безопасно для аудитории сайта.',
  'uses-optimized-images': 'Оптимизируйте тяжелые изображения перед загрузкой на сайт.',
  'uses-responsive-images': 'Добавьте изображения подходящего размера для мобильных и десктопных экранов.',
  'offscreen-images': 'Добавьте lazy loading для изображений ниже первого экрана.',
  'uses-text-compression': 'Включите gzip/brotli на стороне сервера или проверьте настройки отдачи статических файлов.',
  'server-response-time': 'Проверьте тяжелые блоки, внешние виджеты и кеширование главной страницы.',
  redirects: 'Уберите лишние переходы между URL, если они не нужны для canonical/HTTPS.',
  'uses-long-cache-ttl': 'Настройте более долгий кеш для неизменяемых CSS, JS и изображений.',
  'cache-insight': 'Настройте более долгий кеш для статических файлов, которые редко меняются.',
  'image-size-responsive': 'Загружайте изображения в размере, близком к фактическому размеру отображения.',
  'unsized-images': 'Добавьте width/height или CSS aspect-ratio для изображений, чтобы уменьшить сдвиги макета.',
  'third-party-summary': 'Проверьте сторонние скрипты и оставьте только те, которые реально нужны.',
  'font-display': 'Добавьте font-display: swap для подключаемых шрифтов.',
  'layout-shifts': 'Зафиксируйте размеры изображений, iframe, баннеров и динамических блоков.',
  'network-dependency-tree-insight': 'Сократите цепочку критических запросов: уберите лишние ранние скрипты, объедините мелкие зависимости и отложите необязательные виджеты.',
  'lcp-discovery-insight': 'Сделайте LCP-ресурс заметным для браузера раньше: проверьте preload/fetchpriority и не прячьте главный ресурс за поздним JS/CSS.',
  'lcp-phases-insight': 'Посмотрите, какая фаза LCP самая дорогая: ответ сервера, загрузка ресурса или отрисовка элемента.',
  'lcp-breakdown-insight': 'Разберите вклад сервера, загрузки ресурса и отрисовки в LCP; оптимизируйте самый дорогой участок.',
  'cls-culprits-insight': 'Найдите элементы, которые двигают макет, и задайте им стабильные размеры.',
  'document-latency-insight': 'Снизьте задержку первого HTML-ответа: проверьте тяжелые блоки, внешние запросы и кеширование.',
  'render-blocking-insight': 'Отложите некритичные CSS/JS и оставьте в head только ресурсы, нужные для первого экрана.',
  'font-display-insight': 'Настройте font-display: swap для подключаемых шрифтов.',
  'image-delivery-insight': 'Сжимайте изображения, отдавайте подходящие размеры и используйте современные форматы там, где это безопасно.',
  'first-contentful-paint': 'Сократите время до первого контента: проверьте ответ сервера, блокирующие ресурсы и ранние скрипты.',
  'largest-contentful-paint': 'Оптимизируйте главный элемент первого экрана и ресурсы, от которых зависит его появление.',
  'speed-index': 'Уберите блокирующие ресурсы и тяжелые элементы, которые замедляют визуальное заполнение страницы.',
  viewport: 'Проверьте meta viewport в head страницы.',
  'largest-contentful-paint-element': 'Оптимизируйте главный визуальный элемент первого экрана: размер, формат, приоритет загрузки.',
  'document-title': 'Добавьте понятный уникальный title.',
  'meta-description': 'Добавьте понятное уникальное meta description.',
  'http-status-code': 'Проверьте ответ страницы и цепочку редиректов.',
  'crawlable-anchors': 'Используйте обычные href-ссылки для важных переходов.',
  'is-crawlable': 'Проверьте robots/meta robots и не закрывайте важные страницы от индексации.',
  'robots-txt': 'Проверьте синтаксис robots.txt и запреты индексации.',
  'hreflang': 'Проверьте hreflang-ссылки и их обратные связи.',
  canonical: 'Проверьте canonical URL и убедитесь, что он ведет на основную публичную страницу.'
};

export async function runLighthouseAudit(url, options = {}) {
  // Тот же слот, что и у браузерной диагностики: Chrome поднимают оба, и делить
  // машину они должны по одной общей очереди, а не по двум независимым.
  try {
    return await withBrowserSlot(() => runLighthouseInternal(url, options));
  } catch (error) {
    return unavailableResult(normalizeTargetUrl(url), String(error?.message ?? error));
  }
}

async function runLighthouseInternal(url, options = {}) {
  const targetUrl = normalizeTargetUrl(url);
  const categories = normalizeCategories(options.categories);
  const formFactor = options.formFactor === 'desktop' ? 'desktop' : 'mobile';
  const output = normalizeOutput(options.output);
  // Сохранять отчёты на диск нужно не всегда. В витрине они живут только в памяти
  // сессии и уходят по ссылке: класть их ещё и на диск сервера незачем.
  // На нашем хостинге по умолчанию тоже не пишем: путь к файлу на нашем диске удалённому
  // клиенту бесполезен, а каждый вызов оставлял бы там по полтора мегабайта навсегда.
  const persistReports = options.persistReports ?? process.env.MCP_HOSTED !== '1';

  let lighthouse;
  let chromeLauncher;
  try {
    lighthouse = (await import('lighthouse')).default;
    chromeLauncher = await import('chrome-launcher');
  } catch (error) {
    return unavailableResult(targetUrl, `Lighthouse не установлен или не загрузился: ${error.message}`);
  }

  // Та же проверка, что и в браузерной диагностике: Chrome поднимают оба места, и
  // упираться в таймаут вместо честного отказа не должно ни одно из них.
  const memory = chromeMemoryCheck();
  if (!memory.ok) return unavailableResult(targetUrl, memory.reason, { formFactor, categories });

  let chrome;
  try {
    chrome = await chromeLauncher.launch({ chromeFlags: CHROME_FLAGS });

    const result = await lighthouse(targetUrl, {
      port: chrome.port,
      logLevel: 'error',
      output,
      onlyCategories: categories,
      formFactor,
      screenEmulation: screenEmulationFor(formFactor),
      throttlingMethod: 'simulate'
    });

    // Неудачная запись файлов НЕ отменяет уже полученный аудит.
    //
    // Раньше запись стояла внутри общего try, и любая её ошибка улетала в catch снаружи:
    // диск кончился, каталог только для чтения, у процесса нет прав. Минута работы Chrome
    // выбрасывалась целиком, а человек получал сообщение «Lighthouse не удалось запустить»,
    // хотя запустился он прекрасно и всё посчитал. Файлы это удобство, а результат уже есть.
    let reportFiles = [];
    let reportFilesError = '';
    if (persistReports) {
      try {
        reportFiles = await writeLighthouseReports(result, { output });
      } catch (error) {
        reportFilesError = `Отчёт посчитан, но сохранить его файлами не удалось: ${error.message}`;
      }
    }
    // Официальный отчёт Lighthouse в исходном виде. Именно его человек открывает руками,
    // и держать его только файлом на нашем диске бессмысленно: в удалённом режиме
    // пользователь до этого диска не доберётся.
    //
    // Разбираем по позиции, а не по виду содержимого. Lighthouse отдаёт отчёты в том же
    // порядке, в каком их запросили в output, и это его гарантия. Угадывать формат по
    // первым символам нельзя: HTML-отчёт начинается не с комментария, а с doctype, и
    // прошлая попытка «определить на глаз» тихо не находила ни одного из двух файлов.
    const rawReports = pickRawReports(result.report, output);
    const summary = summarizeLighthouse(result.lhr);

    return {
      available: true,
      url: targetUrl,
      scannedAt: new Date().toISOString(),
      formFactor,
      categories,
      summary,
      reportFiles,
      // Если файлы сохранить не удалось, говорим об этом, но результат отдаём.
      reportFilesError,
      rawHtml: rawReports.html ?? null,
      rawJson: rawReports.json ?? null,
      lhr: {
        lighthouseVersion: result.lhr.lighthouseVersion,
        finalDisplayedUrl: result.lhr.finalDisplayedUrl,
        requestedUrl: result.lhr.requestedUrl,
        fetchTime: result.lhr.fetchTime,
        categories: extractCategories(result.lhr),
        audits: extractAudits(result.lhr)
      }
    };
  } catch (error) {
    return unavailableResult(targetUrl, `Lighthouse не удалось запустить: ${error.message}`, {
      formFactor,
      categories
    });
  } finally {
    // Уборка через общий модуль: он проверяет, что процесс действительно закончился, и
    // добивает его, если нет. Пустой обработчик ошибки, который стоял здесь раньше,
    // прятал утечку: на боевом сервере Chrome продолжал жить и через десять минут после
    // конца прогона, по сорок мегабайт на процесс.
    await killChrome(chrome);
  }
}

/** Английские названия категорий Lighthouse для отчёта на английском. */
const CATEGORY_LABELS_EN = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best Practices',
  seo: 'SEO',
  pwa: 'PWA'
};

export function lighthouseChecksFromResult(lighthouseResult) {
  if (!lighthouseResult?.available) return [];
  const url = lighthouseResult.url;
  const checks = [];

  for (const category of lighthouseResult.summary.categories ?? []) {
    if (category.score === null) continue;
    // Низкая оценка категории это повод заняться сайтом, но не блокер индексации.
    // Исключение SEO: там низкая оценка означает, что поисковик и правда плохо понимает
    // страницу, а это ровно то, чем занят весь остальной отчёт.
    if (category.score < 50 && category.id === 'seo') {
      checks.push(issue('critical', `lighthouse.${category.id}_low`, url, `${category.title}: ${category.score}/100.`, 'Такая оценка значит, что поисковик плохо понимает страницу. Откройте отчёт Lighthouse и начните с блока SEO.',
        { messageEn: `${CATEGORY_LABELS_EN[category.id] ?? category.id}: ${category.score}/100.`, fixEn: 'Open the Lighthouse report and fix the most expensive recommendations first.' }));
    } else if (category.score < 90) {
      checks.push(issue('recommended', `lighthouse.${category.id}_needs_work`, url, `${category.title}: ${category.score}/100.`, 'Посмотрите рекомендации Lighthouse и внесите точечные правки.',
        { messageEn: `${CATEGORY_LABELS_EN[category.id] ?? category.id}: ${category.score}/100.`, fixEn: 'Review the Lighthouse recommendations and apply targeted fixes.' }));
    } else {
      checks.push(pass(`lighthouse.${category.id}_ok`, url, `${category.title}: ${category.score}/100.`));
    }
  }

  for (const item of lighthouseResult.summary.topIssues ?? []) {
    checks.push(issue(item.severity, `lighthouse.${item.id}`, url, item.message, item.fix,
      { messageEn: item.messageEn, fixEn: item.fixEn }));
  }

  return checks;
}

/**
 * Проверки Lighthouse, которые действительно мешают попасть в индекс.
 *
 * Раньше важность брали прямо из оценки Lighthouse: меньше 0.5 значит «критично». Но
 * Lighthouse ставит ноль почти всему, что не идеально, поэтому в критичные приезжали
 * лишний CSS, отсутствующие source maps и устаревшие API браузера. На живых сайтах это
 * давало по двенадцать-тринадцать «критичных» пунктов на каждом, включая сайты, где наши
 * собственные проверки не нашли ни одной проблемы. Отчёт, который пугает, никто не чинит.
 *
 * Здесь только то, чего нет среди наших проверок и что при этом реально закрывает дорогу
 * поисковику. Отсутствие title, description, viewport, запрет в robots и мёртвый статус
 * страницы сюда не входят намеренно: их находит наш собственный движок, и дублировать их
 * значило бы считать одну проблему дважды.
 */
const BLOCKING_AUDITS = new Set([
  // Ссылки сделаны обработчиком, а не href: робот по ним не пройдёт.
  'crawlable-anchors',
  // Языковые версии размечены неверно: страницы конкурируют друг с другом в выдаче.
  'hreflang'
]);

/**
 * Отбирает рекомендации Lighthouse для отчёта.
 *
 * Список ограничен: двенадцати пунктов достаточно, чтобы понять, чем заняться, а полный
 * разбор всех аудитов человек всё равно не прочитает и он есть в самом отчёте Lighthouse.
 *
 * Порядок отбора важен, и раньше он был неверным. Сортировка шла по величине экономии
 * времени загрузки, а у блокеров индексации экономии нет вообще: ноль. Поэтому на сайте
 * с длинным списком рекомендаций единственный настоящий блокер уезжал в конец списка и
 * обрезался. То есть терялась именно та проверка, ради которой отчёт и читают.
 *
 * Теперь блокеры идут первыми и в обрезку не попадают, а остальное сортируется как раньше.
 * Функция экспортируется, чтобы обрезку можно было проверить тестом: раньше она жила
 * внутри и тест до неё не доставал.
 */
export function pickTopIssues(audits) {
  const failing = Object.values(audits ?? {})
    .filter((audit) => audit.score !== null && audit.score !== undefined && audit.score < 0.9)
    .filter((audit) => audit.scoreDisplayMode !== 'notApplicable')
    .map((audit) => ({
      id: audit.id,
      title: audit.title,
      score: Math.round(audit.score * 100),
      displayValue: formatDisplayValue(audit.displayValue ?? ''),
      savingsMs: audit.details?.overallSavingsMs ?? 0,
      savingsBytes: audit.details?.overallSavingsBytes ?? 0,
      severity: BLOCKING_AUDITS.has(audit.id) ? 'critical' : 'recommended',
      message: formatAuditMessage(audit),
      fix: AUDIT_FIXES[audit.id] ?? 'Откройте HTML-отчет Lighthouse и примените рекомендацию после проверки влияния на шаблоны.',
      // Оригинальные формулировки Lighthouse. Нужны для отчёта на английском: без них
      // туда попадал наш русский текст, и «английский» отчёт был наполовину русским.
      messageEn: [audit.title, audit.displayValue ? `(${audit.displayValue})` : ''].filter(Boolean).join(' '),
      fixEn: 'Open the Lighthouse HTML report and apply the recommendation after checking how it affects templates.'
    }));

  const byWeight = (a, b) => b.savingsMs - a.savingsMs || b.savingsBytes - a.savingsBytes || a.score - b.score;
  const blockers = failing.filter((x) => x.severity === 'critical').sort(byWeight);
  const rest = failing.filter((x) => x.severity !== 'critical').sort(byWeight);

  return [...blockers, ...rest].slice(0, Math.max(12, blockers.length));
}

function summarizeLighthouse(lhr) {
  const categories = Object.entries(lhr.categories ?? {}).map(([id, category]) => ({
    id,
    title: CATEGORY_LABELS[id] ?? category.title ?? id,
    score: category.score === null || category.score === undefined ? null : Math.round(category.score * 100)
  }));

  const metrics = Object.entries(METRIC_LABELS)
    .map(([id, label]) => {
      const audit = lhr.audits?.[id];
      if (!audit) return null;
      return {
        id,
        label,
        value: audit.displayValue ?? String(audit.numericValue ?? ''),
        score: typeof audit.score === 'number' ? Math.round(audit.score * 100) : null
      };
    })
    .filter(Boolean);

  const topIssues = pickTopIssues(lhr.audits);

  return {
    categories,
    metrics,
    topIssues
  };
}

function extractCategories(lhr) {
  return Object.fromEntries(Object.entries(lhr.categories ?? {}).map(([id, category]) => [id, {
    title: category.title,
    score: category.score
  }]));
}

function extractAudits(lhr) {
  return Object.fromEntries(Object.values(lhr.audits ?? {}).map((audit) => [audit.id, {
    title: audit.title,
    score: audit.score,
    scoreDisplayMode: audit.scoreDisplayMode,
    displayValue: audit.displayValue,
    description: audit.description
  }]));
}

async function writeLighthouseReports(result, options = {}) {
  const outputs0 = normalizeOutput(options.output);
  // Пустой список форматов означает «файлы не нужны». Каталог при этом тоже не создаём:
  // пустая папка reports на сервере только сбивает с толку.
  if (!outputs0.length) return [];

  const outDir = resolve('reports');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files = [];
  const reports = Array.isArray(result.report) ? result.report : [result.report];
  const outputs = outputs0;

  for (let index = 0; index < outputs.length; index += 1) {
    const ext = outputs[index] === 'html' ? 'html' : 'json';
    const file = join(outDir, `lighthouse-report-${stamp}.${ext}`);
    await writeFile(file, reports[index] ?? '', 'utf8');
    files.push(file);
  }

  return files;
}

function normalizeTargetUrl(url) {
  if (!url) throw new Error('Нужен URL для Lighthouse-аудита.');
  return new URL(url).href;
}

function normalizeCategories(value) {
  if (!value) return ['performance', 'accessibility', 'best-practices', 'seo'];
  const categories = Array.isArray(value) ? value : String(value).split(',');
  return categories.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * Раскладывает отчёты Lighthouse по форматам.
 *
 * Lighthouse отдаёт строку, если формат запрошен один, и массив в порядке output, если
 * форматов несколько. Опираемся именно на этот порядок: он документирован, в отличие от
 * попытки распознать формат по началу строки.
 */
function pickRawReports(report, outputs) {
  const list = Array.isArray(report) ? report : [report];
  const out = { html: null, json: null };
  outputs.forEach((format, index) => {
    const value = list[index];
    if (typeof value !== 'string' || !value) return;
    if (format === 'html') out.html = value;
    if (format === 'json') out.json = value;
  });
  return out;
}

function normalizeOutput(value) {
  if (!value) return ['json', 'html'];
  if (Array.isArray(value)) return value;
  if (value === 'all') return ['json', 'html'];
  return [value];
}

function screenEmulationFor(formFactor) {
  if (formFactor === 'desktop') {
    return {
      mobile: false,
      width: 1350,
      height: 940,
      deviceScaleFactor: 1,
      disabled: false
    };
  }

  return {
    mobile: true,
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    disabled: false
  };
}

function unavailableResult(url, message, extra = {}) {
  return {
    available: false,
    url,
    scannedAt: new Date().toISOString(),
    message,
    ...extra,
    summary: {
      categories: [],
      metrics: [],
      topIssues: []
    },
    reportFiles: []
  };
}

function formatAuditMessage(audit) {
  const value = audit.displayValue ? ` (${formatDisplayValue(audit.displayValue)}).` : '.';
  const title = AUDIT_LABELS[audit.id] ?? audit.title;
  return `${title}${value}`;
}

function formatDisplayValue(value) {
  return String(value ?? '')
    .replace(/^Est savings of\s+/i, 'примерная экономия: ')
    .replace(/^Potential savings of\s+/i, 'потенциальная экономия: ')
    .replace(/\brequests\b/gi, 'запросов')
    .replace(/\brequest\b/gi, 'запрос')
    .replace(/\bKiB\b/g, 'КиБ')
    .replace(/\bms\b/g, 'мс')
    .replace(/\bs\b/g, 'с');
}

function issue(severity, code, url, message, fix, extra = {}) {
  return { severity, code, url, message, fix, ...extra };
}

function pass(code, url, message) {
  return { severity: 'pass', code, url, message };
}
