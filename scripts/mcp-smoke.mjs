import { spawn } from 'node:child_process';
import { once } from 'node:events';

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

const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.1.0' } });
notify('notifications/initialized');
const list = await request('tools/list');
const call = await request('tools/call', {
  name: 'plan_safe_fixes',
  arguments: {
    auditResult: {
      startUrl: 'https://example.ucoz.net',
      scannedAt: new Date().toISOString(),
      checks: [
        { severity: 'critical', code: 'meta.viewport_missing', url: 'https://example.ucoz.net', message: 'Отсутствует viewport.', fix: 'Добавить viewport.' }
      ]
    }
  }
});
const preview = await request('tools/call', {
  name: 'preview_template_fix',
  arguments: {
    name: 'AHEADER.html',
    html: '<html><head><title>Тест</title></head><body><h1>Тест</h1></body></html>',
    description: 'Короткое описание тестовой страницы.'
  }
});
const bundle = await request('tools/call', {
  name: 'audit_html_bundle',
  arguments: {
    baseUrl: 'https://example.ucoz.net/',
    format: 'markdown',
    items: [
      {
        name: 'AHEADER.html',
        sourceType: 'template',
        html: '<html><head><title>Тест</title></head><body><img src="/x.png"></body></html>'
      }
    ]
  }
});

console.log(JSON.stringify({
  server: init.result?.serverInfo?.name,
  tools: list.result?.tools?.map((tool) => tool.name),
  rezultatVyzova: JSON.parse(call.result?.content?.[0]?.text ?? '{}').summary,
  previewChanges: JSON.parse(preview.result?.content?.[0]?.text ?? '{}').changes,
  bundleSummary: JSON.parse(bundle.result?.content?.[0]?.text ?? '{}').summary
}, null, 2));

child.stdin.end();
child.kill();
await once(child, 'exit');
