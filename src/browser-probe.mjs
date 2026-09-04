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

const CONSOLE_LIMIT = 200;
const NETWORK_LIMIT = 500;

/**
 * @param {string} url страница для проверки
 * @param {{waitMs?: number, formFactor?: 'mobile'|'desktop', chromePath?: string}} options
 */
export async function collectBrowserDiagnostics(url, options = {}) {
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
  const requests = new Map();
  const startedAt = Date.now();

  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (consoleMessages.length >= CONSOLE_LIMIT) return;
    consoleMessages.push({
      level: p.type,
      text: (p.args ?? []).map(describeRemoteObject).join(' ').slice(0, 500),
      source: 'console',
      url: p.stackTrace?.callFrames?.[0]?.url ?? ''
    });
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails ?? {};
    jsErrors.push({
      text: (d.exception?.description ?? d.text ?? 'Ошибка JavaScript').slice(0, 800),
      url: d.url ?? d.stackTrace?.callFrames?.[0]?.url ?? '',
      line: d.lineNumber ?? null
    });
  });

  // Сообщения самого браузера: смешанный контент, нарушения CSP, отказы загрузки.
  // Их в console.log не видно, а для диагностики сайта это часто самое важное.
  cdp.on('Log.entryAdded', (p) => {
    if (consoleMessages.length >= CONSOLE_LIMIT) return;
    const e = p.entry ?? {};
    consoleMessages.push({
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
  await waitForLoad(cdp, 30000);
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

  const errors = consoleMessages.filter((m) => m.level === 'error');
  const warnings = consoleMessages.filter((m) => m.level === 'warning' || m.level === 'warn');

  return {
    available: true,
    url: target,
    scannedAt: new Date().toISOString(),
    formFactor,
    ms: Date.now() - startedAt,
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

/** Ждём Page.loadEventFired, но не бесконечно: висящий сайт не должен занимать слот. */
function waitForLoad(cdp, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    cdp.once('Page.loadEventFired', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Адрес WebSocket отладчика Chrome отдаёт сам по своему HTTP-порту. */
async function debuggerWebSocketUrl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (!data.webSocketDebuggerUrl) throw new Error('Chrome не отдал адрес отладчика.');
  return data.webSocketDebuggerUrl;
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
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
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
