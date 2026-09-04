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

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const message = readMessage();
    if (!message) break;
    await handleMessage(message);
  }
});

process.stdin.resume();

function readMessage() {
  const textStart = buffer.slice(0, Math.min(buffer.length, 32)).toString('utf8');
  if (!/^content-length:/i.test(textStart)) {
    const newlineEnd = buffer.indexOf('\n');
    if (newlineEnd === -1) return null;
    const line = buffer.slice(0, newlineEnd).toString('utf8').trim();
    buffer = buffer.slice(newlineEnd + 1);
    return line ? JSON.parse(line) : null;
  }

  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const header = buffer.slice(0, headerEnd).toString('utf8');
  const contentLengthMatch = header.match(/content-length:\s*(\d+)/i);
  if (!contentLengthMatch) {
    buffer = buffer.slice(headerEnd + 4);
    return null;
  }

  const length = Number(contentLengthMatch[1]);
  const start = headerEnd + 4;
  const end = start + length;
  if (buffer.length < end) return null;

  const body = buffer.slice(start, end).toString('utf8');
  buffer = buffer.slice(end);
  return JSON.parse(body);
}

async function handleMessage(message) {
  if (!message || !message.method) return;

  try {
    if (message.method === 'initialize') {
      return sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo
      });
    }

    if (message.method === 'notifications/initialized') return;

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

    sendError(message.id, -32601, `Метод не найден: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.stack || error.message || String(error));
  }
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
