/**
 * Тесты HAR.
 *
 * HAR это единственный файл в архиве, который человек открывает не у нас, а в чужом
 * просмотрщике: в панели разработчика браузера или на онлайн-анализаторе. Поэтому
 * несоответствие спецификации здесь не косметика: файл либо рисует неправильную картину,
 * либо отвергается.
 *
 * Закрепляем две поломки, которые в файле были:
 *   1. Всем запросам ставилась ОДНА метка времени, взятая в момент сборки файла, то есть
 *      уже после загрузки страницы. Водопад схлопывался в одну точку и был бесполезен.
 *   2. У незавершённого запроса time равнялся минус единице при timings в сумме ноль.
 *      Спецификация требует, чтобы time равнялся сумме timings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHar } from '../src/browser-probe.mjs';

const requests = [
  { url: 'https://site/', method: 'GET', type: 'Document', wallTime: 1_756_000_000, ms: 120, status: 200, mimeType: 'text/html', bytes: 5000 },
  { url: 'https://site/style.css', method: 'GET', type: 'Stylesheet', wallTime: 1_756_000_001, ms: 40, status: 200, mimeType: 'text/css', bytes: 900 },
  // Запрос, который не успел завершиться: длительности нет.
  { url: 'https://site/late.js', method: 'GET', type: 'Script', wallTime: 1_756_000_002, ms: null, status: null, mimeType: '', bytes: 0 }
];

test('у каждого запроса своя метка времени, а не общая на всех', () => {
  const har = buildHar('https://site/', requests, Date.parse('2026-09-05T00:00:00Z'));
  const stamps = har.log.entries.map((e) => e.startedDateTime);

  assert.equal(new Set(stamps).size, 3, `метки должны различаться, получены: ${stamps.join(', ')}`);
  assert.deepEqual([...stamps].sort(), stamps, 'записи должны идти по возрастанию времени');

  // Метка берётся из данных запроса, а не из момента сборки файла.
  assert.equal(stamps[0], new Date(1_756_000_000 * 1000).toISOString());
  assert.equal(har.log.pages[0].startedDateTime, stamps[0],
    'старт страницы это старт самого раннего запроса');
});

test('time равен сумме timings, в том числе у незавершённого запроса', () => {
  const har = buildHar('https://site/', requests, Date.now());
  for (const entry of har.log.entries) {
    const { send, wait, receive } = entry.timings;
    assert.equal(entry.time, send + wait + receive,
      `${entry.request.url}: time ${entry.time} не равен сумме timings ${send + wait + receive}`);
    assert.ok(entry.time >= 0, `${entry.request.url}: отрицательное время`);
  }
});

test('без wallTime берётся начало прогона, а не момент сборки файла', () => {
  const runStart = Date.parse('2026-09-05T00:00:00Z');
  const har = buildHar('https://site/', [{ url: 'https://site/', method: 'GET', ms: 10 }], runStart);
  assert.equal(har.log.entries[0].startedDateTime, new Date(runStart).toISOString());
});

test('пустой список запросов не ломает файл', () => {
  const har = buildHar('https://site/', [], Date.parse('2026-09-05T00:00:00Z'));
  assert.equal(har.log.version, '1.2');
  assert.deepEqual(har.log.entries, []);
  assert.equal(har.log.pages[0].startedDateTime, '2026-09-05T00:00:00.000Z');
});

test('на негодном адресе браузерная часть отвечает отказом, а не исключением', async () => {
  // Обработчик ошибки сам звал разборщик адреса, который на пустой и на битой строке
  // бросает. То есть падал именно тот код, который должен был превратить сбой в понятный
  // ответ, и наружу вместо «браузерная часть недоступна» улетал сырой Invalid URL.
  const { collectBrowserDiagnostics } = await import('../src/browser-probe.mjs');
  const browser = await collectBrowserDiagnostics('');
  assert.equal(browser.available, false);
  assert.match(browser.reason, /адрес/i, 'причина должна быть на человеческом языке');

  const { runLighthouseAudit } = await import('../src/lighthouse-audit.mjs');
  const lighthouse = await runLighthouseAudit('не адрес');
  assert.equal(lighthouse.available, false);
  assert.ok(lighthouse.summary, 'сводка должна быть на месте, иначе отчёт не соберётся');
});
