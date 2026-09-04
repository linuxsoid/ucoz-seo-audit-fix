#!/usr/bin/env node
/**
 * Локальный транспорт MCP: stdio.
 *
 * Формат обмена по спецификации MCP: одно JSON-RPC сообщение на строку, разделитель
 * это перевод строки. Никаких заголовков Content-Length, это формат LSP, а не MCP.
 *
 * Список тулов и их выполнение живут в mcp-core.mjs и общие с HTTP-транспортом.
 */
import { serverInfo, tools, callTool } from './mcp-core.mjs';

let buffer = Buffer.alloc(0);

/**
 * Разбор запускаем по цепочке, а не параллельно. Два chunk-а, пришедших подряд, иначе
 * начали бы читать один и тот же буфер одновременно.
 */
let pump = Promise.resolve();

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump = pump.then(drain).catch((error) => {
    // Что угодно, но не падение: сессия MCP живёт весь сеанс работы редактора, и обрывать
    // её из-за одного плохого сообщения нельзя. В stdout при этом ничего, кроме JSON-RPC,
    // не пишем: там канал протокола, а не место для диагностики.
    process.stderr.write(`сбой разбора входа: ${error?.stack || error}\n`);
  });
});

process.stdin.resume();

/** Буфер ещё не содержит целого сообщения, ждём следующий chunk. */
const NEED_MORE = Symbol('нужно больше данных');
/** Кадр из буфера забрали, но сообщения в нём не было. Идём к следующему. */
const SKIP = Symbol('кадр пропущен');

/**
 * Разбирает из буфера все сообщения, какие в нём уже лежат целиком.
 *
 * Раньше цикл останавливался на первом же кадре без сообщения, а таким кадром была любая
 * пустая строка между сообщениями. Всё, что лежало в буфере дальше, молча ждало
 * следующего chunk, и если клиент больше ничего не присылал, не обрабатывалось никогда.
 */
async function drain() {
  while (true) {
    const frame = readFrame();
    if (frame === NEED_MORE) return;
    if (frame === SKIP) continue;
    await handleMessage(frame);
  }
}

function readFrame() {
  const textStart = buffer.slice(0, Math.min(buffer.length, 32)).toString('utf8');
  if (!/^content-length:/i.test(textStart)) {
    const newlineEnd = buffer.indexOf('\n');
    if (newlineEnd === -1) return NEED_MORE;
    const line = buffer.slice(0, newlineEnd).toString('utf8').trim();
    buffer = buffer.slice(newlineEnd + 1);
    if (!line) return SKIP;
    return parseFrame(line);
  }

  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return NEED_MORE;
  const header = buffer.slice(0, headerEnd).toString('utf8');
  const contentLengthMatch = header.match(/content-length:\s*(\d+)/i);
  if (!contentLengthMatch) {
    buffer = buffer.slice(headerEnd + 4);
    return SKIP;
  }

  const length = Number(contentLengthMatch[1]);
  const start = headerEnd + 4;
  const end = start + length;
  if (buffer.length < end) return NEED_MORE;

  const body = buffer.slice(start, end).toString('utf8');
  buffer = buffer.slice(end);
  return parseFrame(body);
}

/**
 * Разбирает одно сообщение. Битый JSON это не повод падать: по спецификации JSON-RPC на
 * него положено ответить ошибкой -32700 с id равным null и продолжать слушать. Раньше
 * исключение отсюда улетало в асинхронный обработчик stdin и роняло весь процесс: одна
 * опечатка клиента обрывала сессию MCP до перезапуска редактора.
 */
function parseFrame(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    sendError(null, -32700, `Не удалось разобрать JSON: ${error.message}`);
    return SKIP;
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;

  // Запрос без метода это Invalid Request. Молчать нельзя: клиент ждёт ответа на свой id
  // и будет ждать его до таймаута.
  if (typeof message.method !== 'string') {
    if (message.id !== undefined) sendError(message.id, -32600, 'В запросе нет метода.');
    return;
  }

  try {
    if (message.method === 'initialize') {
      return sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo
      });
    }

    if (message.method === 'notifications/initialized') return;

    // ping обязателен по спецификации: им клиент проверяет, что сервер жив. Мы отвечали
    // на него ошибкой «метод не найден», и клиент имел все основания считать сервер
    // сломанным. По HTTP он был обработан, по stdio нет.
    if (message.method === 'ping') return sendResult(message.id, {});

    if (message.method === 'tools/list') {
      return sendResult(message.id, { tools });
    }

    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      return sendResult(message.id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
    }

    // На нотификацию отвечать нельзя даже ошибкой: у неё нет id, и клиент такой ответ не
    // ждёт. Неизвестная нотификация по спецификации просто игнорируется.
    if (message.id === undefined) return;
    sendError(message.id, -32601, `Метод не найден: ${message.method}`);
  } catch (error) {
    if (message.id === undefined) {
      process.stderr.write(`ошибка при обработке нотификации ${message.method}: ${error?.stack || error}\n`);
      return;
    }
    sendError(message.id, -32000, error.stack || error.message || String(error));
  }
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  // id обязателен даже в ошибке: undefined исчезает при сериализации, и клиент получает
  // ответ без поля id, который не может сопоставить со своим запросом.
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
