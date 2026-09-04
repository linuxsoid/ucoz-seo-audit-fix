#!/usr/bin/env node
/**
 * Remote MCP: транспорт Streamable HTTP.
 *
 * Зачем он нужен. При stdio-подключении пользователь обязан поставить пакет себе на
 * машину: нужен Node нужной версии, npx, а для Lighthouse ещё и Chrome. Для владельца
 * сайта, который не программист, это стена. При remote-подключении сервис крутится у
 * нас, а человек вставляет в Codex, Cursor или Claude один URL и всё. Ставить нечего.
 *
 * Список тулов и их выполнение общие со stdio-режимом, они лежат в mcp-core.mjs.
 * Здесь только транспорт.
 *
 * Что реализовано из спецификации Streamable HTTP:
 *   POST   /mcp   принимает JSON-RPC сообщение или массив сообщений, отвечает
 *                 обычным JSON. Сервер не инициирует сообщения сам, поэтому поток
 *                 text/event-stream не нужен и не открывается.
 *   GET    /mcp   405. Ответ честный: server-initiated поток мы не предлагаем.
 *   DELETE /mcp   204. Состояния сессии нет, удалять нечего.
 *
 * Почему без сессий. Все тулы здесь без состояния: запрос пришёл, аудит выполнен,
 * ответ ушёл. Хранить сессию не за чем, а её отсутствие снимает целый класс проблем
 * при нескольких воркерах.
 *
 * Безопасность:
 *   - Проверяется заголовок Origin. Без этого браузер на чужом сайте может дергать
 *     локально запущенный сервер от имени пользователя, это классическая атака
 *     DNS rebinding, и спецификация MCP отдельно про неё предупреждает.
 *   - Необязательный bearer-токен через MCP_TOKEN. Если задан, без него доступа нет.
 *   - Ограничение размера тела запроса.
 *
 * Переменные окружения:
 *   MCP_TOKEN        если задан, требуется заголовок Authorization: Bearer <token>
 *   MCP_ALLOW_ORIGIN список разрешённых Origin через запятую, либо * . По умолчанию
 *                    запросы без Origin (обычные клиенты MCP) разрешены, а из браузера
 *                    только с перечисленных адресов
 *   MCP_HOSTED       1 для нашего хостинга: убирает из списка тулы, которым нужен
 *                    локальный Chrome или запись в локальную файловую систему
 *   MCP_ALLOW_LIGHTHOUSE  1 возвращает run_lighthouse_audit в удалённом режиме. Ставить
 *                    только там, где на сервере реально есть Chrome, иначе тул будет
 *                    падать у каждого пользователя
 *   PORT, HOST       только при самостоятельном запуске этого файла
 */

import { createServer } from 'node:http';
import { serverInfo, tools, callTool } from './mcp-core.mjs';

const MCP_TOKEN = process.env.MCP_TOKEN || '';
const ALLOW_ORIGIN = (process.env.MCP_ALLOW_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean);
const HOSTED = process.env.MCP_HOSTED === '1';
const MAX_BODY = 1024 * 1024;

/**
 * Тулы, которые на нашем хостинге работать не могут, и поэтому там не показываются.
 *
 * Показывать тул, который всегда падает, хуже, чем не показывать его вовсе: агент
 * потратит на него вызов и выдаст пользователю ошибку вместо результата.
 *
 *   run_lighthouse_audit  поднимает Chrome. В окружении серверных скриптов uCoz
 *                         браузера нет.
 *   fix_template_file     пишет в локальный файл. На нашем сервере локальных файлов
 *                         пользователя нет, править надо через официальный ucoz-mcp.
 */
const HOSTED_BLOCKLIST = new Set(['run_lighthouse_audit', 'fix_template_file']);

// На хостинге с установленным Chrome (например на своём VPS) Lighthouse работать может,
// и прятать его там незачем. Запись в локальные файлы остаётся закрытой всегда: файловая
// система сервера пользователю не принадлежит.
if (process.env.MCP_ALLOW_LIGHTHOUSE === '1') HOSTED_BLOCKLIST.delete('run_lighthouse_audit');

export const publicTools = HOSTED ? tools.filter((tool) => !HOSTED_BLOCKLIST.has(tool.name)) : tools;

/**
 * Обработчик одного HTTP-запроса к эндпоинту MCP.
 * Экспортируется, чтобы web-server.mjs мог смонтировать MCP и витрину в один процесс:
 * на хостинге это один Node-апп и один URL, а не два сервиса.
 */
export async function handleMcpRequest(req, res) {
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    return sendJson(res, 403, jsonRpcError(null, -32600, 'Origin не разрешён.'), origin);
  }
  if (MCP_TOKEN) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${MCP_TOKEN}`) {
      res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'application/json' });
      return res.end(JSON.stringify(jsonRpcError(null, -32001, 'Нужен корректный bearer-токен.')));
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders(origin),
      'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version',
      'access-control-max-age': '86400'
    });
    return res.end();
  }

  // Поток от сервера к клиенту мы не предлагаем, поэтому GET честно отвечает 405.
  if (req.method === 'GET') {
    res.writeHead(405, { allow: 'POST, DELETE, OPTIONS', ...corsHeaders(origin) });
    return res.end();
  }

  // Сессий нет, поэтому удалять нечего, но отвечаем корректно, а не 404.
  if (req.method === 'DELETE') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST, DELETE, OPTIONS', ...corsHeaders(origin) });
    return res.end();
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, jsonRpcError(null, -32700, String(error.message)), origin);
  }

  const batch = Array.isArray(payload);
  const messages = batch ? payload : [payload];
  const responses = [];

  for (const message of messages) {
    const result = await handleMessage(message);
    if (result) responses.push(result);
  }

  // Если пришли только уведомления, отвечать нечем. По спецификации это 202.
  if (!responses.length) {
    res.writeHead(202, corsHeaders(origin));
    return res.end();
  }

  return sendJson(res, 200, batch ? responses : responses[0], origin);
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || !message.method) {
    return jsonRpcError(message?.id ?? null, -32600, 'Некорректный JSON-RPC запрос.');
  }

  // Уведомление: у него нет id и ответа на него не полагается.
  const isNotification = message.id === undefined || message.id === null;

  try {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo
        }
      };
    }

    if (message.method.startsWith('notifications/')) return null;
    if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };

    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id: message.id, result: { tools: publicTools } };
    }

    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (HOSTED && HOSTED_BLOCKLIST.has(name)) {
        return jsonRpcError(message.id, -32601,
          `Тул ${name} недоступен в удалённом режиме: ему нужен локальный Chrome или доступ к вашей файловой системе. Поставьте пакет локально, если он нужен.`);
      }
      const result = await callTool(name, message.params?.arguments ?? {});
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      };
    }

    if (isNotification) return null;
    return jsonRpcError(message.id, -32601, `Метод не найден: ${message.method}`);
  } catch (error) {
    if (isNotification) return null;
    return jsonRpcError(message.id, -32000, String(error?.message ?? error));
  }
}

/**
 * Обычные клиенты MCP заголовок Origin не шлют вовсе, и это нормально: он есть только
 * у браузера. Поэтому отсутствие Origin разрешено, а браузерный Origin проверяется по
 * списку. Так закрывается DNS rebinding, но не ломаются нормальные клиенты.
 */
function isOriginAllowed(origin) {
  if (!origin) return true;
  if (!ALLOW_ORIGIN.length) return false;
  return ALLOW_ORIGIN.includes('*') || ALLOW_ORIGIN.includes(origin);
}

function corsHeaders(origin) {
  if (!origin || !ALLOW_ORIGIN.length) return {};
  return {
    'access-control-allow-origin': ALLOW_ORIGIN.includes('*') ? '*' : origin,
    'vary': 'Origin'
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function sendJson(res, status, payload, origin) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...corsHeaders(origin)
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Слишком большое тело запроса.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) throw new Error('Пустое тело запроса.');
  return JSON.parse(raw);
}

// Самостоятельный запуск: node src/mcp-http.mjs
// В обычной поставке MCP монтируется внутрь web-server.mjs на тот же порт.
if (process.argv[1] && process.argv[1].endsWith('mcp-http.mjs')) {
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? '0.0.0.0';
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/mcp') return handleMcpRequest(req, res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Эндпоинт MCP находится на /mcp' }));
  }).listen(port, host, () => {
    console.log(`Remote MCP слушает http://${host}:${port}/mcp`);
    console.log(`тулов доступно: ${publicTools.length}${HOSTED ? ' (режим хостинга, часть тулов скрыта)' : ''}`);
    console.log(MCP_TOKEN ? 'авторизация: bearer-токен обязателен' : 'авторизация: выключена, MCP_TOKEN не задан');
  });
}
