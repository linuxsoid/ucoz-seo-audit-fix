/**
 * Тесты транспорта и списка тулов MCP.
 *
 * Транспорт проверяется запуском настоящего процесса, а не вызовом функций. Это не
 * перестраховка: первая версия сервера использовала кадрирование из LSP, с заголовком
 * Content-Length, и молча не отвечала ни на одно сообщение по спецификации MCP. Тот баг
 * был невидим, потому что смоук-тест кормил сервер тем же неправильным форматом и всегда
 * проходил. Тест, который сам себе подыгрывает, хуже отсутствия теста.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tools } from '../src/mcp-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Прогоняет через stdio-сервер список сообщений и собирает ответы.
 * @param {string} input то, что уходит в stdin ДОСЛОВНО, включая переводы строк
 */
function runStdio(input, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'mcp-server.mjs')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });

    const done = (reason) => {
      clearTimeout(timer);
      try { child.kill(); } catch { /* уже мёртв */ }
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try { messages.push(JSON.parse(line)); } catch { messages.push({ _непарсится: line }); }
      }
      resolve({ messages, stderr: err, reason, exitCode: child.exitCode });
    };

    const timer = setTimeout(() => done('таймаут'), timeoutMs);
    child.on('exit', () => done('процесс завершился'));

    child.stdin.write(input);
  });
}

const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
});

test('stdio отвечает на формат по спецификации: одно сообщение на строку', async () => {
  const { messages, stderr } = await runStdio(`${initialize}\n`);

  const answer = messages.find((m) => m.id === 1);
  assert.ok(answer, `сервер не ответил на initialize. stdout: ${JSON.stringify(messages)} stderr: ${stderr}`);
  assert.equal(answer.jsonrpc, '2.0');
  assert.ok(answer.result?.serverInfo?.name, 'в ответе нет serverInfo');
  assert.ok(answer.result?.protocolVersion, 'в ответе нет protocolVersion');
});

test('stdio выдаёт список тулов', async () => {
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const { messages } = await runStdio(`${initialize}\n${list}\n`);

  const answer = messages.find((m) => m.id === 2);
  assert.ok(answer, 'нет ответа на tools/list');
  assert.ok(Array.isArray(answer.result?.tools), 'tools не массив');
  assert.equal(answer.result.tools.length, tools.length, 'список по stdio расходится с mcp-core');
});

test('на нотификацию сервер не отвечает', async () => {
  // У нотификации нет id, и ответ на неё это нарушение JSON-RPC: клиент его не ждёт.
  const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const { messages } = await runStdio(`${initialize}\n${note}\n`);

  const extra = messages.filter((m) => m.id !== 1);
  assert.deepEqual(extra, [], `сервер ответил на нотификацию: ${JSON.stringify(extra)}`);
});

test('неизвестный метод получает ошибку -32601, а не молчание', async () => {
  const bogus = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'нет/такого', params: {} });
  const { messages } = await runStdio(`${initialize}\n${bogus}\n`);

  const answer = messages.find((m) => m.id === 3);
  assert.ok(answer, 'на неизвестный метод сервер промолчал');
  assert.equal(answer.error?.code, -32601);
});

test('битая строка не убивает процесс и не съедает следующие сообщения', async () => {
  // Клиент может прислать мусор: обрыв, лишний перевод строки, не тот кодек. После этого
  // сервер обязан продолжать работать, иначе одна опечатка вешает всю сессию.
  const list = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  const { messages, stderr, exitCode } = await runStdio(`${initialize}\n{это не json\n${list}\n`);

  assert.ok(messages.find((m) => m.id === 1), 'ответ на initialize потерян');
  assert.ok(
    messages.find((m) => m.id === 5),
    `после битой строки сервер перестал отвечать. exitCode=${exitCode} stderr=${stderr.slice(0, 400)}`
  );
});

test('два сообщения в одной записи разбираются оба', async () => {
  // stdin приходит кусками произвольного размера, склейка двух сообщений в один chunk
  // это норма, а не редкость.
  const list = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  const { messages } = await runStdio(`${initialize}\n${list}\n`);

  assert.ok(messages.find((m) => m.id === 1));
  assert.ok(messages.find((m) => m.id === 7));
});

test('битая строка получает ответ -32700 с id равным null', async () => {
  const { messages } = await runStdio(`${initialize}\n{битый\n`);

  const parseError = messages.find((m) => m.error?.code === -32700);
  assert.ok(parseError, 'на битый JSON положено отвечать ошибкой разбора, а не молчать');
  assert.equal(parseError.id, null, 'у ответа на неразобранное сообщение id должен быть null');
});

test('пустая строка между сообщениями не глушит разбор', async () => {
  // stdin приходит одним куском, и если разбор остановится на пустой строке, всё, что за
  // ней, не обработается никогда: следующего chunk-а уже не будет.
  const list = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
  const { messages } = await runStdio(`${initialize}\n\n\n${list}\n`);

  assert.ok(messages.find((m) => m.id === 9), 'сообщение после пустых строк потеряно');
});

test('запрос без метода получает -32600, а не тишину', async () => {
  const broken = JSON.stringify({ jsonrpc: '2.0', id: 11, params: {} });
  const { messages } = await runStdio(`${initialize}\n${broken}\n`);

  const answer = messages.find((m) => m.id === 11);
  assert.ok(answer, 'клиент будет ждать ответа на свой id до таймаута');
  assert.equal(answer.error?.code, -32600);
});

test('на неизвестную нотификацию сервер молчит', async () => {
  const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/нетакой', params: {} });
  const { messages } = await runStdio(`${initialize}\n${note}\n`);

  const extra = messages.filter((m) => m.id !== 1);
  assert.deepEqual(extra, [], `ответ на нотификацию это нарушение JSON-RPC: ${JSON.stringify(extra)}`);
});

test('описания тулов и их схемы согласованы', () => {
  for (const tool of tools) {
    assert.ok(tool.name, 'у тула нет имени');
    assert.ok(tool.description, `${tool.name}: нет описания`);
    const schema = tool.inputSchema;
    assert.ok(schema, `${tool.name}: нет inputSchema`);
    assert.equal(schema.type, 'object', `${tool.name}: корень схемы должен быть object`);
    assert.ok(schema.properties, `${tool.name}: в схеме нет properties`);

    // required должен быть подмножеством properties, иначе клиент не сможет вызвать тул:
    // он обязан прислать поле, которого в схеме нет.
    for (const field of schema.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(schema.properties, field),
        `${tool.name}: required требует поле «${field}», которого нет в properties`
      );
    }
  }
});

test('имена тулов уникальны', () => {
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [...new Set(names)], 'есть тулы с одинаковыми именами');
});

test('stdio отвечает на ping, а не ошибкой «метод не найден»', async () => {
  // ping обязателен по спецификации: им клиент проверяет, жив ли сервер. Мы отвечали
  // ошибкой, и клиент имел все основания считать сервер сломанным.
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'ping', params: {} });
  const { messages } = await runStdio(`${initialize}\n${ping}\n`);

  const answer = messages.find((m) => m.id === 21);
  assert.ok(answer, 'на ping сервер не ответил');
  assert.ok(!answer.error, `на ping пришла ошибка: ${JSON.stringify(answer.error)}`);
  assert.deepEqual(answer.result, {});
});
