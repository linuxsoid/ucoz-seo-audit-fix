/**
 * Тесты истории проверок.
 *
 * Закрепляем три вещи:
 *   1. Разница считается по конкретным проблемам на конкретных страницах, а не по
 *      счётчикам. Счётчик может стоять на месте, когда одно починили, а другое сломали.
 *   2. Адрес присылает посторонний, а из адреса строится имя файла. Любая попытка
 *      выйти за каталог истории должна давать отказ, а не файл в чужом месте.
 *   3. История второстепенна: битый файл и негодный адрес не роняют проверку.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory, siteKey, diffSnapshots, snapshotOf } from '../src/history.mjs';

const result = (checks, at = '2026-10-14T10:00:00.000Z') => ({
  scannedAt: at,
  pages: [{}, {}],
  summary: {
    critical: checks.filter((c) => c.severity === 'critical').length,
    recommended: checks.filter((c) => c.severity === 'recommended').length,
    passed: 3
  },
  checks
});

const desc = (url) => ({ code: 'meta.description_missing', severity: 'critical', url });
const og = (url) => ({ code: 'social.og_missing', severity: 'recommended', url });

async function tempHistory(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'seo-history-'));
  return { dir, history: createHistory({ dir, ...options }), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('первая проверка сайта: прошлой нет, разницы нет', async () => {
  const { history, cleanup } = await tempHistory();
  try {
    const out = await history.record('https://example.com/', result([desc('https://example.com/')]));
    assert.equal(out.previous, null);
    assert.equal(out.diff, null);
    assert.equal(out.saved, true);
  } finally {
    await cleanup();
  }
});

test('вторая проверка показывает, что ушло и что появилось', async () => {
  const { history, cleanup } = await tempHistory();
  try {
    await history.record('https://example.com/', result([
      desc('https://example.com/'), desc('https://example.com/a'), og('https://example.com/')
    ], '2026-10-13T10:00:00.000Z'));

    const out = await history.record('https://example.com/', result([
      og('https://example.com/'), og('https://example.com/new')
    ]));

    assert.equal(out.previous.scannedAt, '2026-10-13T10:00:00.000Z');
    assert.equal(out.diff.fixed, 2, 'описание вернули на двух страницах');
    assert.equal(out.diff.appeared, 1, 'og пропал на новой странице');
    assert.deepEqual(out.diff.fixedByCode.map((e) => [e.code, e.count]), [['meta.description_missing', 2]]);
    assert.deepEqual(out.diff.appearedByCode.map((e) => [e.code, e.count]), [['social.og_missing', 1]]);
  } finally {
    await cleanup();
  }
});

test('счётчик на месте, а разница есть: одно починили, другое сломали', () => {
  // Ровно тот случай, ради которого разница считается по ключам, а не по сводке.
  const before = snapshotOf(result([desc('https://s/a')]));
  const after = snapshotOf(result([desc('https://s/b')]));
  const diff = diffSnapshots(before, after);
  assert.equal(diff.delta.critical, 0, 'счётчик критичных не сдвинулся');
  assert.equal(diff.fixed, 1);
  assert.equal(diff.appeared, 1);
});

test('www и без www, слэш и путь это один и тот же сайт', async () => {
  const { history, cleanup } = await tempHistory();
  try {
    await history.record('https://www.example.com/', result([desc('https://example.com/')]));
    const out = await history.record('https://example.com/catalog/', result([]));
    assert.ok(out.previous, 'вторая запись должна найти первую');
    assert.equal(out.diff.fixed, 1);
  } finally {
    await cleanup();
  }
});

test('из адреса нельзя построить путь вне каталога истории', () => {
  const bad = [
    'https://../../etc/passwd',
    'file:///etc/passwd',
    'не адрес',
    '',
    null,
    'https://exa mple.com/'
  ];
  for (const url of bad) {
    const key = siteKey(url);
    assert.ok(key === null || /^[a-z0-9.-]+$/.test(key) && !key.includes('..'),
      `адрес ${JSON.stringify(url)} дал опасный ключ ${JSON.stringify(key)}`);
  }
  assert.equal(siteKey('https://Пример.рф/'), 'xn--e1afmkfd.xn--p1ai', 'кириллица уходит в punycode');
});

test('негодный адрес не роняет проверку и ничего не пишет', async () => {
  const { dir, history, cleanup } = await tempHistory();
  try {
    const out = await history.record('не адрес', result([]));
    assert.deepEqual(out, { previous: null, diff: null, saved: false });
    const files = await readdir(dir).catch(() => []);
    assert.deepEqual(files, []);
  } finally {
    await cleanup();
  }
});

test('битый файл истории читается как пустая история, а не как ошибка', async () => {
  const { dir, history, cleanup } = await tempHistory();
  try {
    await writeFile(join(dir, 'example.com.json'), '{ это не json', 'utf8');
    const out = await history.record('https://example.com/', result([]));
    assert.equal(out.previous, null);
    assert.equal(out.saved, true);
  } finally {
    await cleanup();
  }
});

test('хранится не больше заданного числа проверок на сайт', async () => {
  const { history, cleanup } = await tempHistory({ keep: 3 });
  try {
    for (let i = 0; i < 6; i += 1) {
      await history.record('https://example.com/', result([], `2026-10-0${i + 1}T00:00:00.000Z`));
    }
    const entries = await history.list('https://example.com/');
    assert.equal(entries.length, 3);
    assert.equal(entries[0].scannedAt, '2026-10-04T00:00:00.000Z', 'остались три последние');
  } finally {
    await cleanup();
  }
});

test('чистка оставляет не больше заданного числа сайтов', async () => {
  const { dir, history, cleanup } = await tempHistory({ maxSites: 2 });
  try {
    for (const host of ['a.com', 'b.com', 'c.com', 'd.com']) {
      await history.record(`https://${host}/`, result([]));
    }
    await history.prune();
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 2);
  } finally {
    await cleanup();
  }
});

test('в слепок не попадает содержимое чужих страниц', () => {
  const snap = snapshotOf({
    ...result([desc('https://s/')]),
    pages: [{ url: 'https://s/', html: '<html>секретный текст страницы</html>' }]
  });
  assert.equal(JSON.stringify(snap).includes('секретный'), false);
});
