/**
 * История проверок по сайту.
 *
 * Зачем. До этого модуля сервис был одноразовым: результат жил в памяти пятнадцать минут,
 * и на следующий день человек, поправивший сайт, не мог узнать, что изменилось. При этом
 * сравнение двух проверок (compare_audits) было давно написано и даже обещано на лендинге,
 * а с витрины им нельзя было воспользоваться вообще. Повторная проверка с ответом «ушло
 * три проблемы, появилась одна» это причина вернуться, и без истории её не построить.
 *
 * Что храним. Не весь результат, а слепок: когда проверяли, сводку и список ключей
 * замечаний «код|адрес». Этого достаточно для разницы и стоит сотни байт, а не сотни
 * килобайт. Содержимое чужих страниц на диск не попадает.
 *
 * Где. По одному JSON-файлу на сайт в HISTORY_DIR. Базы не нужно: чтение и запись идут
 * по одному файлу, и обращаемся мы к нему раз в проверку.
 */

import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'history');

/** Сколько проверок одного сайта помнить. Для разницы нужна одна, остальное запас на график. */
export const KEEP_PER_SITE = 20;

/** Сколько сайтов помнить всего. Старые вытесняются по дате изменения файла. */
export const MAX_SITES = 5000;

/** Сколько ключей замечаний хранить в одном слепке. Ограничение от раздувания файла. */
const MAX_KEYS = 2000;

/**
 * Ключ сайта и имя файла.
 *
 * www и без www это один сайт для владельца, поэтому www отрезаем. Имя файла строится
 * только из букв, цифр, точки и дефиса: адрес присылает посторонний, и любая попытка
 * просунуть в него «../» должна давать отказ, а не путь вне каталога.
 */
export function siteKey(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  // Кириллические домены приходят из URL уже в punycode, поэтому кириллица здесь не нужна.
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..') || host.startsWith('.')) return null;
  return host;
}

/** Ключ одного замечания. Тот же, что у compare_audits, чтобы разница считалась одинаково. */
function issueKey(check) {
  return `${check.code}|${check.url}`;
}

/** Слепок результата проверки, который кладём на диск. */
export function snapshotOf(result) {
  const issues = (result.checks ?? [])
    .filter((check) => check.severity === 'critical' || check.severity === 'recommended')
    .map((check) => ({ key: issueKey(check), severity: check.severity, code: check.code }));

  return {
    scannedAt: result.scannedAt ?? new Date().toISOString(),
    pagesScanned: (result.pages ?? []).length,
    // Какие страницы вошли в проверку. Без этого разница врёт: если в этот раз обход
    // дошёл до новых страниц, все их замечания выглядели бы как «появилось», хотя сайт
    // не стал хуже. Ровно так и случилось на нашем же сайте после починки sitemap:
    // «появилось 87».
    pages: (result.pages ?? []).map((page) => page.url).filter(Boolean).slice(0, 200),
    summary: {
      critical: result.summary?.critical ?? 0,
      recommended: result.summary?.recommended ?? 0,
      passed: result.summary?.passed ?? 0
    },
    issues: issues.slice(0, MAX_KEYS)
  };
}

/**
 * Разница между двумя слепками.
 *
 * Считаем по ключам «код|адрес», а не по сводке. Сводка врёт в простом случае: одну
 * проблему починили, другая появилась, и счётчик тот же, а человеку надо знать и то, и
 * другое. Списки отдаём сгруппированными по коду: «пропало описание на 5 страницах»
 * читается, а пять одинаковых строк с адресами нет.
 */
export function diffSnapshots(before, after) {
  const beforeKeys = new Map((before?.issues ?? []).map((issue) => [issue.key, issue]));
  const afterKeys = new Map((after?.issues ?? []).map((issue) => [issue.key, issue]));

  // Старые слепки без списка страниц сравниваем как раньше, все замечания сравнимы.
  const beforePages = Array.isArray(before?.pages) ? new Set(before.pages) : null;
  const afterPages = Array.isArray(after?.pages) ? new Set(after.pages) : null;
  const urlOf = (issue) => issue.key.slice(issue.key.indexOf('|') + 1);

  // Страница появилась в обходе только сейчас: её замечания не «новые», а «впервые
  // увиденные». И наоборот, страница выпала из обхода: её замечания не «исправлены».
  const onNewPage = (issue) => Boolean(beforePages && afterPages
    && afterPages.has(urlOf(issue)) && !beforePages.has(urlOf(issue)));
  const onDroppedPage = (issue) => Boolean(beforePages && afterPages
    && beforePages.has(urlOf(issue)) && !afterPages.has(urlOf(issue)));

  const gone = [...beforeKeys.values()].filter((issue) => !afterKeys.has(issue.key));
  const added = [...afterKeys.values()].filter((issue) => !beforeKeys.has(issue.key));

  const fixed = gone.filter((issue) => !onDroppedPage(issue));
  const appeared = added.filter((issue) => !onNewPage(issue));
  const newPagesIssues = added.filter(onNewPage);
  const newPages = beforePages && afterPages
    ? [...afterPages].filter((url) => !beforePages.has(url)).length
    : 0;

  const group = (list) => {
    const byCode = new Map();
    for (const issue of list) {
      const entry = byCode.get(issue.code) ?? { code: issue.code, severity: issue.severity, count: 0 };
      entry.count += 1;
      if (issue.severity === 'critical') entry.severity = 'critical';
      byCode.set(issue.code, entry);
    }
    return [...byCode.values()].sort((a, b) =>
      (a.severity === b.severity ? b.count - a.count : a.severity === 'critical' ? -1 : 1));
  };

  return {
    fixed: fixed.length,
    appeared: appeared.length,
    fixedByCode: group(fixed),
    appearedByCode: group(appeared),
    newPages,
    newPagesIssues: newPagesIssues.length,
    delta: {
      critical: (after?.summary?.critical ?? 0) - (before?.summary?.critical ?? 0),
      recommended: (after?.summary?.recommended ?? 0) - (before?.summary?.recommended ?? 0)
    }
  };
}

export function createHistory(options = {}) {
  const dir = options.dir ?? process.env.HISTORY_DIR ?? DEFAULT_DIR;
  const keep = options.keep ?? KEEP_PER_SITE;
  const maxSites = options.maxSites ?? MAX_SITES;
  let pruneRunning = null;

  async function load(key) {
    try {
      const data = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'));
      return Array.isArray(data?.entries) ? data : { site: key, entries: [] };
    } catch {
      // Нет файла или он битый: для истории это одно и то же, начинаем с чистого листа.
      // Ронять проверку из-за истории нельзя, история здесь второстепенна.
      return { site: key, entries: [] };
    }
  }

  async function save(key, data) {
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${key}.json`);
    // Через временный файл и rename: оборванная на середине запись не должна оставить
    // полфайла, который потом прочитается как пустая история.
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, target);
  }

  async function prune() {
    let names;
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    if (names.length <= maxSites) return;
    const withTime = await Promise.all(names.map(async (name) => {
      try {
        return { name, mtime: (await stat(join(dir, name))).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    }));
    withTime.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of withTime.slice(0, names.length - maxSites)) {
      await unlink(join(dir, name)).catch(() => {});
    }
  }

  return {
    dir,

    /** Последний слепок сайта или null. */
    async latest(url) {
      const key = siteKey(url);
      if (!key) return null;
      const data = await load(key);
      return data.entries.at(-1) ?? null;
    },

    /** Все слепки сайта, от старых к новым. */
    async list(url) {
      const key = siteKey(url);
      if (!key) return [];
      return (await load(key)).entries;
    },

    /**
     * Записывает новый результат и возвращает предыдущий слепок и разницу с ним.
     * Ошибки записи не пробрасываются: история не стоит упавшей проверки.
     */
    async record(url, result) {
      const key = siteKey(url);
      if (!key) return { previous: null, diff: null, saved: false };

      const data = await load(key);
      const previous = data.entries.at(-1) ?? null;
      const snapshot = snapshotOf(result);
      const diff = previous ? diffSnapshots(previous, snapshot) : null;

      data.site = key;
      data.entries = [...data.entries, snapshot].slice(-keep);

      let saved = true;
      try {
        await save(key, data);
      } catch {
        saved = false;
      }

      // Чистка каталога раз в несколько записей и не параллельно сама с собой.
      if (!pruneRunning && Math.random() < 0.05) {
        pruneRunning = prune().finally(() => { pruneRunning = null; });
      }

      return {
        previous: previous ? { scannedAt: previous.scannedAt, summary: previous.summary } : null,
        diff,
        saved
      };
    },

    prune
  };
}
