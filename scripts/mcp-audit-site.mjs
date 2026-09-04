import { spawn } from 'node:child_process';
import { once } from 'node:events';

const url = process.argv[2];
const maxPages = Number(process.argv[3] ?? 5);

if (!url) {
  console.error('Использование: node ./scripts/mcp-audit-site.mjs <url> [maxPages]');
  process.exit(1);
}

const child = spawn(process.execPath, ['./src/mcp-server.mjs'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['pipe', 'pipe', 'inherit']
});

let id = 1;
let buffer = Buffer.alloc(0);
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const message = readMessage();
    if (!message) break;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});

function request(method, params = {}) {
  const message = { jsonrpc: '2.0', id: id++, method, params };
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  return new Promise((resolve) => pending.set(message.id, resolve));
}

function notify(method, params = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function readMessage() {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const header = buffer.slice(0, headerEnd).toString('utf8');
  const match = header.match(/content-length:\s*(\d+)/i);
  if (!match) throw new Error(`Bad header: ${header}`);
  const length = Number(match[1]);
  const start = headerEnd + 4;
  const end = start + length;
  if (buffer.length < end) return null;
  const body = buffer.slice(start, end).toString('utf8');
  buffer = buffer.slice(end);
  return JSON.parse(body);
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-audit-site', version: '0.1.0' }
  });
  if (init.error) throw new Error(init.error.message);
  notify('notifications/initialized');

  const call = await request('tools/call', {
    name: 'audit_site',
    arguments: { url, maxPages, format: 'all' }
  });
  if (call.error) throw new Error(call.error.message);

  const result = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
  console.log(JSON.stringify({
    svodka: result.summary,
    proverenoStranits: result.pagesScanned,
    faylyOtchetov: result.reportFiles
  }, null, 2));
} finally {
  child.stdin.end();
  child.kill();
  await once(child, 'exit').catch(() => {});
}
