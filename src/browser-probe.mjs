/**
 * Браузерная диагностика страницы: логи консоли, ошибки JavaScript и сетевые запросы.
 *
 * Зачем отдельно от Lighthouse. Lighthouse отвечает на вопрос «насколько быстро и
 * правильно сделана страница» и выдаёт оценки. Он НЕ показывает, что именно ругается в
 * консоли и какой запрос отвалился с ошибкой. Ровно за этим человек обычно и лезет в
 * DevTools руками: открыть сайт, посмотреть красное в консоли, потом вкладку Network,
 * потом сохранить HAR. Здесь это делается одним вызовом.
 *
 * Почему без Playwright и Puppeteer. Chrome на сервере уже есть, его ставит и запускает
 * chrome-launcher ради Lighthouse. Playwright притащил бы вторую копию браузера на сотни
 * мегабайт, а нужны нам ровно три домена протокола DevTools. Общаемся с Chrome напрямую
 * по CDP через WebSocket, встроенный в Node 22. Новых зависимостей ноль.
 *
 * Что собирается:
 *   Runtime.consoleAPICalled   вызовы console.log, warn, error из кода страницы
 *   Runtime.exceptionThrown    необработанные исключения JavaScript
 *   Log.entryAdded             сообщения самого браузера: CSP, смешанный контент,
 *                              отказы загрузки, устаревшие API
 *   Network.*                  все запросы: метод, статус, тип, размер, длительность
 */

import { withBrowserSlot } from './browser-slot.mjs';

const CONSOLE_LIMIT = 200;
const NETWORK_LIMIT = 500;

/**
 * @param {string} url страница для проверки
 * @param {{waitMs?: number, formFactor?: 'mobile'|'desktop', chromePath?: string}} options
 */
export async function collectBrowserDiagnostics(url, options = {}) {
  // Браузер запускается только через очередь: параллельные прогоны душат друг друга
  // по процессору и складывают память. Подробности в browser-slot.mjs.
  try {
    return await withBrowserSlot(() => runDiagnostics(url, options));
  } catch (error) {
    return unavailable(normalizeUrl(url), String(error?.message ?? error));
  }
}

async function runDiagnostics(url, options) {
  const target = normalizeUrl(url);
  const waitMs = clamp(Number(options.waitMs ?? 5000), 0, 20000);

  let chromeLauncher;
  try {
    chromeLauncher = await import('chrome-launcher');
  } catch (error) {
    return unavailable(target, `chrome-launcher не установлен: ${error.message}`);
  }
  if (typeof WebSocket === 'undefined') {
    return unavailable(target, 'В этой версии Node нет встроенного WebSocket. Нужен Node 22 или новее.');
  }

  let chrome;
  try {
    chrome = await chromeLauncher.launch({
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
  } catch (error) {
    return unavailable(target, `Не удалось запустить Chrome: ${error.message}`);
  }

  try {
    const wsUrl = await debuggerWebSocketUrl(chrome.port);
    const cdp = await connect(wsUrl);
    try {
      return await probe(cdp, target, waitMs, options.formFactor === 'desktop' ? 'desktop' : 'mobile');
    } finally {
      cdp.close();
    }
  } catch (error) {
    return unavailable(target, `Диагностика не удалась: ${error.message}`);
  } finally {
    // Chrome закрываем всегда. Незакрытый headless остаётся висеть в памяти, и на
    // небольшой машине несколько таких процессов вытеснят соседние службы.
    try { await chrome.kill(); } catch { /* результат важнее уборки */ }
  }
}

async function probe(cdp, target, waitMs, formFactor) {
  const consoleMessages = [];
  const jsErrors = [];
  // Сколько сообщений выбросили из-за предела. Молчать об этом нельзя: иначе отчёт
  // выглядит полным, а часть сообщений в него просто не попала.
  let droppedMessages = 0;

  /**
   * Складывает сообщение консоли, отдавая приоритет ошибкам.
   *
   * Предел нужен: страница с ошибкой в бесконечном цикле выдаёт тысячи сообщений в
   * секунду. Но раньше при достижении предела выбрасывалось всё подряд, в том числе
   * ошибки. Болтливая страница забивала список отладочными сообщениями, и отчёт
   * сообщал «ошибок консоли нет» ровно на тех сайтах, где их было больше всего.
   *
   * Теперь ошибка вытесняет из заполненного списка обычное сообщение и попадает в отчёт.
   */
  const rememberConsole = (item) => {
    if (consoleMessages.length < CONSOLE_LIMIT) {
      consoleMessages.push(item);
      return;
    }
    const isError = item.level === 'error' || item.level === 'assert';
    if (!isError) {
      droppedMessages += 1;
      return;
    }
    const victim = consoleMessages.findIndex((m) => m.level !== 'error' && m.level !== 'assert');
    if (victim === -1) {
      droppedMessages += 1;
      return;
    }
    consoleMessages.splice(victim, 1);
    consoleMessages.push(item);
    droppedMessages += 1;
  };
  const requests = new Map();
  const startedAt = Date.now();

  cdp.on('Runtime.consoleAPICalled', (p) => {
    rememberConsole({
      level: p.type,
      text: (p.args ?? []).map(describeRemoteObject).join(' ').slice(0, 500),
      source: 'console',
      url: p.stackTrace?.callFrames?.[0]?.url ?? ''
    });
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails ?? {};
    // Предел и здесь: страница в цикле бросает исключения тысячами, а память процесса
    // общая для всех, кто в этот момент проверяет свой сайт.
    if (jsErrors.length >= CONSOLE_LIMIT) { droppedMessages += 1; return; }
    jsErrors.push({
      text: (d.exception?.description ?? d.text ?? 'Ошибка JavaScript').slice(0, 800),
      url: d.url ?? d.stackTrace?.callFrames?.[0]?.url ?? '',
      line: d.lineNumber ?? null
    });
  });

  // Сообщения самого браузера: смешанный контент, нарушения CSP, отказы загрузки.
  // Их в console.log не видно, а для диагностики сайта это часто самое важное.
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry ?? {};
    rememberConsole({
      level: e.level,
      text: String(e.text ?? '').slice(0, 500),
      source: e.source ?? 'browser',
      url: e.url ?? ''
    });
  });

  cdp.on('Network.requestWillBeSent', (p) => {
    if (requests.size >= NETWORK_LIMIT) return;
    requests.set(p.requestId, {
      url: p.request?.url ?? '',
      method: p.request?.method ?? 'GET',
      type: p.type ?? '',
      startedAt: p.timestamp,
      status: null,
      mimeType: '',
      bytes: 0,
      fromCache: false,
      ms: null,
      failed: null
    });
  });

  cdp.on('Network.responseReceived', (p) => {
    const r = requests.get(p.requestId);
    if (!r) return;
    r.status = p.response?.status ?? null;
    r.mimeType = p.response?.mimeType ?? '';
    r.type = p.type ?? r.type;
    r.fromCache = Boolean(p.response?.fromDiskCache || p.response?.fromPrefetchCache);
  });

  cdp.on('Network.loadingFinished', (p) => {
    const r = requests.get(p.requestId);
    if (!r) return;
    r.bytes = p.encodedDataLength ?? 0;
    r.ms = Math.round((p.timestamp - r.startedAt) * 1000);
  });

  cdp.on('Network.loadingFailed', (p) => {
    const r = requests.get(p.requestId);
    if (!r) return;
    r.failed = p.errorText ?? 'failed';
    r.ms = Math.round((p.timestamp - r.startedAt) * 1000);
  });

  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // Мобильный профиль по умолчанию: большинство проблем вёрстки и тяжёлых картинок
  // видно именно на узком экране, и трафик сайтов сегодня в основном мобильный.
  if (formFactor === 'mobile') {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true
    });
  }

  await cdp.send('Page.navigate', { url: target });
  // Ждём событие load, но не бесконечно. Если сайт очень медленный или вообще не
  // досылает ресурсы, ждать до победного нельзя: слот браузера один, и один такой сайт
  // заблокировал бы очередь для всех остальных.
  const loaded = await waitForLoad(cdp, 30000);
  // Часть скриптов и запросов стартует уже после события load, поэтому слушаем ещё
  // немного: без этой паузы отчёт систематически недосчитывает аналитику и виджеты.
  await sleep(waitMs);

  const list = [...requests.values()];
  const failed = list.filter((r) => r.failed || (r.status && r.status >= 400));
  const byType = {};
  let totalBytes = 0;
  for (const r of list) {
    const key = r.type || 'other';
    byType[key] = byType[key] ?? { count: 0, bytes: 0 };
    byType[key].count += 1;
    byType[key].bytes += r.bytes;
    totalBytes += r.bytes;
  }

  // Скриншот страницы целиком. В DevTools это отдельная команда, и в отчёте он полезнее
  // любого описания: сразу видно, что вообще увидел посетитель.
  let screenshot = null;
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: true });
    if (shot?.data) screenshot = shot.data;
  } catch {
    // Скриншот не критичен: страница могла закрыться или оказаться слишком длинной.
  }

  const errors = consoleMessages.filter((m) => m.level === 'error');
  const warnings = consoleMessages.filter((m) => m.level === 'warning' || m.level === 'warn');

  return {
    available: true,
    url: target,
    scannedAt: new Date().toISOString(),
    formFactor,
    ms: Date.now() - startedAt,
    // Честно говорим, дождались ли мы полной загрузки. Молчать об этом нельзя: отчёт по
    // недогруженной странице выглядит законченным, а данных в нём меньше, чем на самом
    // деле, и человек об этом не догадается.
    loadComplete: loaded,
    loadNote: [
      loaded ? '' : 'Страница не сообщила о полной загрузке за 30 секунд. Данные собраны на этот момент, часть поздних запросов и ошибок могла не попасть в отчёт.',
      // О выброшенных сообщениях говорим прямо. Молчать нельзя: отчёт выглядел бы полным,
      // а часть сообщений в него просто не попала, и число ошибок было бы заниженным.
      droppedMessages ? `Страница выдала слишком много сообщений в консоль, в отчёт попали не все: пропущено ${droppedMessages}. Ошибки при этом сохранены в первую очередь.` : ''
    ].filter(Boolean).join(' '),
    droppedMessages,
    har: buildHar(target, list),
    // Консольный лог обычным текстом, как его сохраняет DevTools через «Save as».
    consoleLog: buildConsoleLog(target, consoleMessages, jsErrors),
    // base64, чтобы не таскать бинарь через JSON. Раскодируется при отдаче файла.
    screenshotBase64: screenshot,
    сводка: {
      ошибокКонсоли: errors.length,
      предупреждений: warnings.length,
      ошибокJavaScript: jsErrors.length,
      запросов: list.length,
      неудачныхЗапросов: failed.length,
      весСтраницыКб: Math.round(totalBytes / 1024)
    },
    summary: {
      consoleErrors: errors.length,
      consoleWarnings: warnings.length,
      jsErrors: jsErrors.length,
      requests: list.length,
      failedRequests: failed.length,
      totalKb: Math.round(totalBytes / 1024)
    },
    consoleErrors: errors.slice(0, 50),
    consoleWarnings: warnings.slice(0, 30),
    jsErrors: jsErrors.slice(0, 30),
    failedRequests: failed.slice(0, 50).map(compactRequest),
    byResourceType: byType,
    heaviestRequests: list
      .filter((r) => r.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15)
      .map(compactRequest),
    slowestRequests: list
      .filter((r) => typeof r.ms === 'number')
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 15)
      .map(compactRequest)
  };
}

function compactRequest(r) {
  return {
    url: r.url.slice(0, 300),
    method: r.method,
    status: r.status,
    type: r.type,
    kb: Math.round(r.bytes / 1024),
    ms: r.ms,
    fromCache: r.fromCache,
    error: r.failed ?? undefined
  };
}

/**
 * Ждём Page.loadEventFired, но не бесконечно: висящий сайт не должен занимать слот.
 * Возвращает true, если загрузка действительно завершилась, и false, если вышло время.
 * Разница важна: по ней отчёт честно говорит, полные в нём данные или нет.
 */
function waitForLoad(cdp, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    cdp.once('Page.loadEventFired', () => done(true));
    // Если Chrome умер, ждать событие бессмысленно: оно уже никогда не придёт, а слот
    // браузера один на весь сервис и всё это время занят.
    cdp.onClose(() => done(false));
  });
}

/**
 * Консольный лог в том виде, в каком его сохраняет DevTools: простой текст, по строке на
 * сообщение, с уровнем и источником. Формат нарочно скучный, чтобы его можно было грепать
 * и вставлять в переписку.
 */
function buildConsoleLog(pageUrl, messages, jsErrors) {
  const lines = [
    `# Console log: ${pageUrl}`,
    `# ${new Date().toISOString()}`,
    `# сообщений: ${messages.length}, необработанных ошибок JavaScript: ${jsErrors.length}`,
    ''
  ];

  for (const m of messages) {
    const where = m.url ? ` (${m.url})` : '';
    lines.push(`[${String(m.level || 'log').toUpperCase()}] [${m.source || 'console'}] ${m.text}${where}`);
  }

  if (jsErrors.length) {
    lines.push('', '# Необработанные исключения JavaScript', '');
    for (const e of jsErrors) {
      const where = e.url ? ` (${e.url}${e.line != null ? ':' + e.line : ''})` : '';
      lines.push(`[EXCEPTION] ${e.text}${where}`);
    }
  }

  return lines.join('\n');
}

/**
 * Собирает HAR 1.2 из уже снятых сетевых данных.
 *
 * Зачем формат, а не свой JSON. HAR это то, что человек экспортирует из вкладки Network
 * руками, и его открывают DevTools, Chrome, Firefox и любой сторонний анализатор. Отдавая
 * HAR, мы не заставляем никого разбираться в нашей структуре.
 *
 * Оговорка про полноту: мы пишем то, что даёт протокол при обычном обходе, то есть метод,
 * адрес, статус, тип, размер и длительность. Заголовков и тел ответов здесь нет, они нам
 * для аудита не нужны, а тела к тому же раздули бы файл в десятки раз.
 */
function buildHar(pageUrl, requests) {
  const started = new Date().toISOString();
  return {
    log: {
      version: '1.2',
      creator: { name: 'uCoz SEO Audit & Fix', version: '0.1.0' },
      pages: [{
        startedDateTime: started,
        id: 'page_1',
        title: pageUrl,
        pageTimings: { onContentLoad: -1, onLoad: -1 }
      }],
      entries: requests.map((r) => ({
        pageref: 'page_1',
        startedDateTime: started,
        time: typeof r.ms === 'number' ? r.ms : -1,
        request: {
          method: r.method || 'GET',
          url: r.url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: r.status ?? 0,
          statusText: r.failed ? String(r.failed) : '',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: r.bytes || 0, mimeType: r.mimeType || '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: r.bytes || 0
        },
        cache: {},
        timings: { send: 0, wait: typeof r.ms === 'number' ? r.ms : 0, receive: 0 },
        _resourceType: r.type || '',
        _fromCache: Boolean(r.fromCache)
      }))
    }
  };
}

/**
 * Адрес WebSocket отладчика нужной вкладки.
 *
 * Важная тонкость, на которой легко обжечься: у Chrome два разных вида целей отладки.
 * /json/version отдаёт адрес БРАУЗЕРА, и в этой сессии доменов Network, Page и Runtime
 * просто нет, команда Network.enable возвращает "wasn't found". Домены страницы живут
 * в целях типа page, их список отдаёт /json/list. Берём первую вкладку, а если Chrome
 * запустился совсем без вкладок, просим создать новую через /json/new.
 */
async function debuggerWebSocketUrl(port) {
  const base = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const targets = await fetchJson(`${base}/json/list`);
    const page = (Array.isArray(targets) ? targets : []).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl
    );
    if (page) return page.webSocketDebuggerUrl;
    await sleep(300);
  }

  // Резервный путь: явно создаём пустую вкладку. В новых сборках это PUT, в старых GET.
  for (const method of ['PUT', 'GET']) {
    try {
      const created = await fetchJson(`${base}/json/new?about:blank`, { method });
      if (created?.webSocketDebuggerUrl) return created.webSocketDebuggerUrl;
    } catch { /* пробуем следующий метод */ }
  }

  throw new Error('Chrome не отдал ни одной вкладки для отладки.');
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  return response.json();
}

/**
 * Минимальный клиент CDP поверх встроенного в Node WebSocket.
 * Нужен ровно для двух вещей: послать команду и дождаться ответа по id, и раздать
 * события подписчикам. Полноценная библиотека здесь была бы лишней зависимостью.
 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = new Map();
    let nextId = 1;

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        return msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      }
      if (msg.method) {
        for (const fn of handlers.get(msg.method) ?? []) {
          try { fn(msg.params ?? {}); } catch { /* один плохой обработчик не рушит сбор */ }
        }
        const once = handlers.get('once:' + msg.method);
        if (once) {
          handlers.delete('once:' + msg.method);
          for (const fn of once) { try { fn(msg.params ?? {}); } catch { /* см. выше */ } }
        }
      }
    });

    ws.addEventListener('error', () => reject(new Error('Не удалось подключиться к Chrome по CDP.')));

    /**
     * Обрыв соединения обрабатываем сразу, а не ждём таймаутов.
     *
     * Раньше обработчика close не было. Если Chrome умирал посреди проверки, каждая уже
     * отправленная команда висела до своего таймаута в тридцать секунд, а ожидание
     * загрузки страницы висело ещё тридцать. Слот браузера один на весь сервис, поэтому
     * один упавший Chrome держал проверку недоступной для всех остальных минуты.
     */
    let closed = false;
    const onClose = [];
    ws.addEventListener('close', () => {
      closed = true;
      const dead = new Error('Chrome закрыл соединение до конца проверки.');
      for (const { reject: fail } of pending.values()) fail(dead);
      pending.clear();
      for (const fn of onClose) { try { fn(dead); } catch { /* уборка не важнее причины */ } }
      onClose.length = 0;
    });

    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        if (closed) return Promise.reject(new Error('Chrome закрыл соединение до конца проверки.'));
        const id = nextId++;
        return new Promise((ok, fail) => {
          pending.set(id, { resolve: ok, reject: fail });
          ws.send(JSON.stringify({ id, method, params }));
          setTimeout(() => {
            if (pending.delete(id)) fail(new Error(`Команда ${method} не ответила вовремя.`));
          }, 30000);
        });
      },
      on(method, fn) {
        if (!handlers.has(method)) handlers.set(method, []);
        handlers.get(method).push(fn);
      },
      once(method, fn) {
        const key = 'once:' + method;
        if (!handlers.has(key)) handlers.set(key, []);
        handlers.get(key).push(fn);
      },
      /** Подписка на обрыв. Нужна ожиданиям, чтобы не висеть до таймаута на мёртвом сокете. */
      onClose(fn) {
        if (closed) fn(new Error('Chrome закрыл соединение до конца проверки.'));
        else onClose.push(fn);
      },
      get closed() { return closed; },
      close() { try { ws.close(); } catch { /* соединение и так рвётся */ } }
    }));
  });
}

function describeRemoteObject(arg) {
  if (arg == null) return '';
  if ('value' in arg) return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
  return arg.description ?? arg.type ?? '';
}

function normalizeUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('Не указан адрес страницы.');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unavailable(url, reason) {
  return { available: false, url, reason };
}
