/**
 * Ядро MCP-сервера: описание тулов и их выполнение.
 *
 * Здесь НЕТ ничего про транспорт. Это сделано специально: у сервера два способа
 * подключения, и оба обязаны отдавать один и тот же набор тулов.
 *
 *   src/mcp-server.mjs  локальный запуск по stdio, пакет ставится на машину пользователя
 *   src/mcp-http.mjs    remote MCP по HTTP, сервис крутится у нас, пользователь
 *                       подключается одним URL и ничего не устанавливает
 *
 * Любой новый тул добавляется только здесь и сразу доступен обоим транспортам.
 */
import { auditHtmlBundle, auditSite } from './seo-audit.mjs';
import { writeReports, toMarkdown, toHtml } from './report.mjs';
import { runLighthouseAudit } from './lighthouse-audit.mjs';
import { resolveSafeTarget, assertSafeUrl } from './safe-url.mjs';
import { planSafeFixes } from './safe-fix-plan.mjs';
import { fixTemplateContent, fixTemplateFile } from './template-fix.mjs';
import { compareAudits } from './compare-audits.mjs';
import { collectBrowserDiagnostics } from './browser-probe.mjs';

const serverInfo = {
  name: 'ucoz-seo-audit-fix',
  version: '0.1.0'
};

export { serverInfo };

export const tools = [
  {
    name: 'audit_site',
    description: 'Сканирует публичный URL uCoz-сайта, приоритизирует SEO-проблемы и сохраняет отчёты JSON/Markdown/HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Публичный URL сайта для проверки.' },
        maxPages: { type: 'number', description: 'Максимальное количество внутренних страниц для обхода. По умолчанию: 25.' },
        lighthouse: { type: 'boolean', description: 'Запустить Lighthouse для стартовой страницы и добавить результаты в общий отчёт. По умолчанию: false.' },
        lighthouseFormFactor: { type: 'string', enum: ['mobile', 'desktop'], description: 'Профиль Lighthouse. По умолчанию: mobile.' },
        lighthouseCategories: {
          type: 'array',
          description: 'Категории Lighthouse. По умолчанию: performance, accessibility, best-practices, seo.',
          items: { type: 'string', enum: ['performance', 'accessibility', 'best-practices', 'seo', 'pwa'] }
        },
        format: { type: 'string', enum: ['all', 'json', 'markdown', 'html'], description: 'Формат отчёта. По умолчанию: markdown. HTML запрашивайте явно: он весит в разы больше и в переписке с моделью бесполезен.' }
      },
      required: ['url']
    }
  },
  {
    name: 'run_lighthouse_audit',
    description: 'Запускает Lighthouse/Chrome для URL и возвращает русскую сводку: scores, Core Web Vitals/lab metrics и главные рекомендации.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Публичный URL для проверки Lighthouse.' },
        formFactor: { type: 'string', enum: ['mobile', 'desktop'], description: 'Профиль Lighthouse. По умолчанию: mobile.' },
        categories: {
          type: 'array',
          description: 'Категории Lighthouse. По умолчанию: performance, accessibility, best-practices, seo.',
          items: { type: 'string', enum: ['performance', 'accessibility', 'best-practices', 'seo', 'pwa'] }
        },
        output: {
          type: 'array',
          description: 'Какие Lighthouse-файлы сохранить. По умолчанию: json и html.',
          items: { type: 'string', enum: ['json', 'html'] }
        }
      },
      required: ['url']
    }
  },
  {
    name: 'collect_browser_diagnostics',
    description: 'Открывает страницу в реальном Chrome и возвращает то, за чем обычно лезут в DevTools руками: ошибки и предупреждения консоли, необработанные исключения JavaScript, сообщения браузера про CSP и смешанный контент, все сетевые запросы со статусами, упавшие запросы, самые тяжёлые и самые медленные ресурсы, вес страницы. Lighthouse этого не показывает: он даёт оценки, а не содержимое консоли и сети.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Публичный URL страницы.' },
        waitMs: { type: 'number', description: 'Сколько ждать после загрузки, чтобы поймать отложенные скрипты и запросы. По умолчанию 5000, максимум 20000.' },
        formFactor: { type: 'string', enum: ['mobile', 'desktop'], description: 'Профиль экрана. По умолчанию mobile.' }
      },
      required: ['url']
    }
  },
  {
    name: 'plan_safe_fixes',
    description: 'Классифицирует найденные проблемы: безопасный auto-fix, требуется подтверждение, только вручную, действий не нужно.',
    inputSchema: {
      type: 'object',
      properties: {
        auditResult: { type: 'object', description: 'Полный результат, который вернул audit_site.' }
      },
      required: ['auditResult']
    }
  },
  {
    name: 'audit_html_bundle',
    description: 'Проверяет HTML, полученный из uCoz MCP read_template/list_modules/ftp_tool:read, и возвращает SEO-отчёт без публичного crawler-а.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: 'Базовый публичный URL сайта для нормализации ссылок.' },
        items: {
          type: 'array',
          description: 'Список шаблонов или файлов для проверки.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Название шаблона или файла.' },
              moduleId: { type: 'string', description: 'ID модуля uCoz, например 2 или 20.' },
              templateId: { type: 'string', description: 'ID шаблона uCoz, например 0, 4 или AHEADER.' },
              templateName: { type: 'string', description: 'Явное название шаблона в админке.' },
              adminUrl: { type: 'string', description: 'Опциональная ссылка на шаблон в админке.' },
              url: { type: 'string', description: 'Опциональный URL/идентификатор источника.' },
              sourceType: { type: 'string', description: 'template, module, ftp_file или page.' },
              html: { type: 'string', description: 'HTML-содержимое.' }
            },
            required: ['html']
          }
        },
        format: { type: 'string', enum: ['all', 'json', 'markdown', 'html'], description: 'Формат отчёта. По умолчанию: all.' }
      },
      required: ['items']
    }
  },
  {
    name: 'preview_template_fix',
    description: 'Готовит безопасную правку HTML/шаблона и возвращает patched HTML плюс unified diff, ничего не записывая на диск.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название шаблона или файла для diff.' },
        html: { type: 'string', description: 'Исходный HTML.' },
        title: { type: 'string', description: 'Подтверждённый title для OG-метаданных.' },
        description: { type: 'string', description: 'Подтверждённое описание для meta/OG-метаданных.' }
      },
      required: ['html']
    }
  },
  {
    name: 'fix_template_file',
    description: 'Применяет безопасные meta-исправления к локальному HTML/шаблону и создаёт backup.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Путь к локальному HTML/шаблону.' },
        title: { type: 'string', description: 'Опциональный подтверждённый title для OG-метаданных.' },
        description: { type: 'string', description: 'Опциональное подтверждённое описание для meta/OG-метаданных.' }
      },
      required: ['file']
    }
  },
  {
    name: 'compare_audits',
    description: 'Сравнивает аудит до и после исправлений: сколько проблем ушло, появилось и ухудшился ли сайт.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'object', description: 'Результат аудита до правок.' },
        after: { type: 'object', description: 'Результат аудита после правок.' }
      },
      required: ['before', 'after']
    }
  },
  {
    name: 'ucoz_mcp_demo_workflow',
    description: 'Возвращает пошаговый сценарий демо с официальным ucoz-mcp: read_template, list_modules, ftp_tool, patch_template, validate_template.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', description: 'URL сайта для демо.' }
      }
    }
  }
];


/**
 * Удалённый режим (remote MCP): пакет крутится на нашем сервере, а пользователь только
 * подключён по URL. Писать отчёт в файл на НАШЕМ диске и возвращать ему путь вида
 * C:\...\reports\seo-report.json бессмысленно: этого файла у него нет.
 * Поэтому здесь отчёт возвращается текстом прямо в ответе.
 */
const REMOTE_MODE = process.env.MCP_HOSTED === '1';

async function deliverReports(result, format) {
  if (!REMOTE_MODE) {
    return { reportFiles: await writeReports(result, { format: format ?? 'all' }) };
  }
  // По умолчанию отдаём только markdown. HTML это те же выводы, обёрнутые в разметку
  // страницы: сорок с лишним килобайт, которые в контексте модели ничего не добавляют,
  // а место занимают. Кому нужен HTML, тот попросит его явно.
  const wanted = format ?? 'markdown';
  const out = {};
  if (wanted === 'all' || wanted === 'markdown') out.markdown = toMarkdown(result);
  if (wanted === 'all' || wanted === 'html') out.html = toHtml(result);
  return { report: out, reportFiles: [] };
}

/**
 * Готовит результат к отправке в MCP-клиент.
 *
 * Через MCP результат читает не человек, а модель, и весь он попадает ей в контекст.
 * Поэтому здесь остаётся только то, что можно осмысленно прочитать, а объёмные вложения
 * выбрасываются. Найдено на живом сайте: ответ audit_site весил 5 мегабайт и не влезал
 * в ответ вообще. Разбор по весу был такой:
 *   1.5 МБ  готовые файлы отчёта Lighthouse, HTML и JSON целиком;
 *   0.9 МБ  исходный HTML каждой обойдённой страницы;
 *   0.6 МБ  скриншот страницы в base64;
 *   вдвое   потому что тот же объект отдавался ещё раз под английским ключом.
 *
 * Ничего из этого модели не нужно: выводы уже сделаны и лежат в checks и summary.
 * Файлы отчётов и скриншот забираются с витрины по ссылке, а не через контекст.
 */
function forTransport(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };

  if (Array.isArray(out.pages)) {
    // Исходный HTML и полный список ссылок нужны были самим проверкам, и они уже
    // отработали: битые ссылки посчитаны, обход закончен. Держать их в ответе значит
    // отдать тридцать килобайт адресов, по которым выводы уже сделаны.
    out.pages = out.pages.map(({ html, links, ...page }) => ({ ...page, links: links?.length ?? 0 }));
  }

  if (out.lighthouse) out.lighthouse = trimLighthouse(out.lighthouse);
  if (out.browser) out.browser = trimBrowser(out.browser);

  return out;
}

/** У Lighthouse оставляем выводы и оценки, а готовые файлы отчёта выбрасываем. */
function trimLighthouse(lighthouse) {
  const { rawHtml, rawJson, lhr, ...rest } = lighthouse;
  return {
    ...rest,
    // Пофайловый разбор всех аудитов это ещё 58 КБ ради данных, которые уже сведены
    // в summary.topIssues. Оставляем только шапку отчёта.
    lhr: lhr ? {
      lighthouseVersion: lhr.lighthouseVersion,
      finalDisplayedUrl: lhr.finalDisplayedUrl,
      requestedUrl: lhr.requestedUrl,
      fetchTime: lhr.fetchTime,
      categories: lhr.categories
    } : undefined
  };
}

/**
 * У браузерной части оставляем разбор и список запросов, а сырую запись сети и скриншот
 * выбрасываем.
 *
 * Полный HAR это те же запросы плюс заголовки, тайминги и служебные поля формата: сорок
 * семь килобайт против пятнадцати. Список запросов при этом обещан в описании тула, и
 * выкинуть его вместе с HAR значило бы соврать про то, что тул возвращает.
 */
function trimBrowser(browser) {
  const { har, screenshotBase64, consoleLog, ...rest } = browser;
  const entries = har?.log?.entries ?? [];
  return {
    ...rest,
    requests: entries.map((e) => ({
      url: e.request?.url,
      method: e.request?.method,
      status: e.response?.status,
      type: e._resourceType,
      kb: Math.round((e.response?.content?.size ?? 0) / 1024),
      ms: e.time,
      fromCache: e._fromCache
    }))
  };
}

/**
 * Приводит адрес к безопасному виду, если сервер работает удалённо.
 *
 * Через публичный MCP адрес присылает кто угодно, и без этой проверки тул audit_site
 * оказывался обходным путём мимо всей защиты витрины: можно было попросить сервер сходить
 * на 127.0.0.1 или на сервис метаданных облака и вернуть содержимое.
 *
 * Локально проверка не нужна и мешала бы: там человек проверяет свой же сайт на своей же
 * машине, в том числе на localhost во время разработки.
 */
async function auditTarget(url) {
  return REMOTE_MODE ? resolveSafeTarget(url) : String(url ?? '');
}

/**
 * Сколько страниц обходить.
 *
 * Потолок нужен по той же причине: на публичном сервере maxPages присылает посторонний,
 * и без ограничения одним вызовом можно занять сервер обходом на тысячу страниц.
 *
 * Мусор вместо числа раньше превращался в NaN, и обход заканчивался, не начавшись:
 * pages.length < NaN это false с первой же итерации. Тул отвечал «успешно» и нулём
 * обойдённых страниц, что выглядело как исправный ответ.
 */
function pageLimit(value) {
  const asked = Number(value);
  const fallback = REMOTE_MODE ? 8 : 25;
  const limit = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : fallback;
  return REMOTE_MODE ? Math.min(limit, 20) : Math.min(limit, 200);
}

export async function callTool(name, args) {
  if (name === 'audit_site') {
    const result = await auditSite(await auditTarget(args.url), {
      maxPages: pageLimit(args.maxPages),
      lighthouse: Boolean(args.lighthouse),
      lighthouseFormFactor: args.lighthouseFormFactor ?? 'mobile',
      lighthouseCategories: args.lighthouseCategories,
      lighthouseOutput: ['json', 'html'],
      // В удалённом режиме проверяем каждый адрес, по которому идём. Локально этого не
      // требуется: там адрес вводит сам владелец машины.
      guard: REMOTE_MODE ? assertSafeUrl : null
    });
    const delivered = await deliverReports(result, args.format);
    // Один и тот же объект под русским и английским ключом это буквально двойной вес
    // ответа. Отдаём его один раз, английский ключ ссылается на тот же объект.
    return {
      'сводка': result.summary,
      'провереноСтраниц': result.pages.length,
      'файлыОтчётов': delivered.reportFiles,
      summary: result.summary,
      pagesScanned: result.pages.length,
      ...delivered,
      // Полный разбор отдаётся один раз. Раньше он лежал ещё и под русским ключом, и
      // JSON честно выписывал его дважды: один и тот же объект, двойной вес ответа.
      auditResult: forTransport(result)
    };
  }

  if (name === 'run_lighthouse_audit') {
    const lighthouse = await runLighthouseAudit(args.url, {
      formFactor: args.formFactor ?? 'mobile',
      categories: args.categories,
      output: args.output ?? ['json', 'html']
    });
    return trimLighthouse(lighthouse);
  }

  if (name === 'collect_browser_diagnostics') {
    const browser = await collectBrowserDiagnostics(args.url, {
      waitMs: args.waitMs,
      formFactor: args.formFactor
    });
    return trimBrowser(browser);
  }

  if (name === 'plan_safe_fixes') {
    return planSafeFixes(args.auditResult);
  }

  if (name === 'audit_html_bundle') {
    const result = auditHtmlBundle(args.items ?? [], { baseUrl: args.baseUrl ?? '' });
    const delivered = await deliverReports(result, args.format);
    return {
      'сводка': result.summary,
      'провереноФрагментов': result.pages.length,
      'файлыОтчётов': delivered.reportFiles,
      summary: result.summary,
      fragmentsScanned: result.pages.length,
      ...delivered,
      auditResult: forTransport(result)
    };
  }

  if (name === 'preview_template_fix') {
    return fixTemplateContent(args.html, {
      name: args.name ?? 'template.html',
      title: args.title ?? '',
      description: args.description ?? ''
    });
  }

  if (name === 'fix_template_file') {
    return fixTemplateFile(args.file, {
      title: args.title ?? '',
      description: args.description ?? ''
    });
  }

  if (name === 'compare_audits') {
    return compareAudits(args.before, args.after);
  }

  if (name === 'ucoz_mcp_demo_workflow') {
    return buildUcozMcpWorkflow(args.siteUrl ?? '');
  }

  throw new Error(`Неизвестный tool: ${name}`);
}

function buildUcozMcpWorkflow(siteUrl) {
  return {
    siteUrl,
    goal: 'Полный цикл audit -> safe fix -> diff -> approve -> повторный audit для uCoz-сайта.',
    requiredMcpServers: ['ucoz', 'ucoz-seo-audit-fix'],
    steps: [
      'Вызвать ucoz-seo-audit-fix.audit_site для публичного URL и получить baseline.',
      'Вызвать официальный ucoz-mcp list_modules, чтобы понять активные модули сайта.',
      'Через официальный ucoz-mcp read_template прочитать AHEADER/BFOOTER и шаблоны активных модулей.',
      'При необходимости через официальный ucoz-mcp ftp_tool:read прочитать robots.txt, sitemap.xml, статические HTML/JS/CSS-файлы.',
      'Передать HTML в ucoz-seo-audit-fix.audit_html_bundle и получить проблемы именно по шаблонам/файлам.',
      'Вызвать ucoz-seo-audit-fix.plan_safe_fixes и отделить safe_auto_fix от approve_required и manual_only.',
      'Для каждого safe_auto_fix вызвать ucoz-seo-audit-fix.preview_template_fix и показать diff.',
      'После подтверждения применить точечный diff через официальный ucoz-mcp patch_template или ftp_tool:write.',
      'Вызвать официальный ucoz-mcp validate_template.',
      'Повторить ucoz-seo-audit-fix.audit_site и сравнить before/after через compare_audits.'
    ],
    safetyRules: [
      'Не переписывать контент автоматически.',
      'Не менять canonical, robots.txt, редиректы и Schema.org без подтверждения.',
      'Перед записью всегда показывать diff.',
      'Держать backup или пользоваться backup официального ucoz-mcp.',
      'Фактические ошибки отделять от рекомендаций.'
    ]
  };
}
