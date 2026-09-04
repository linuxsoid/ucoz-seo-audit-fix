/**
 * Тесты защиты от SSRF.
 *
 * Публичный эндпоинт принимает адрес от кого угодно, поэтому здесь закрепляется главное:
 * проверяется КАЖДЫЙ адрес, по которому сервер реально идёт, а не только тот, который
 * прислали. Разница не теоретическая: сайт отвечает перенаправлением на 127.0.0.1 или на
 * 169.254.169.254, то есть на сервис метаданных облака, и без этой проверки сервер честно
 * идёт туда и возвращает содержимое тому, кто прислал адрес.
 *
 * Проверку через перенаправление гоняем на настоящем локальном сервере: подменять fetch
 * бессмысленно, проверять надо тот код, который работает в бою.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolveSafeTarget, assertSafeUrl, isSafeUrl } from '../src/safe-url.mjs';
import { auditSite } from '../src/seo-audit.mjs';

test('петлевые и внутренние адреса отклоняются', async () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://127.0.0.1:80/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    // CGNAT: тоже не публичный адрес, через него ходят к оборудованию провайдера.
    'http://100.64.0.1/'
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertSafeUrl(url), undefined, `пропущен внутренний адрес: ${url}`);
  }
});

test('нестандартная схема и порт отклоняются', async () => {
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'));
  await assert.rejects(() => assertSafeUrl('ftp://example.com/'));
  // Иначе публичный сервис превращается в сканер портов чужой сети.
  await assert.rejects(() => assertSafeUrl('https://example.com:8080/'));
  await assert.rejects(() => assertSafeUrl('https://example.com:22/'));
});

test('адрес с логином и паролем отклоняется', async () => {
  // Иначе наш сервер уходит авторизованным туда, куда его послали.
  await assert.rejects(() => assertSafeUrl('https://user:secret@example.com/'));
});

test('адрес без схемы дописывается до https', async () => {
  assert.equal(await resolveSafeTarget('example.com'), 'https://example.com/');
});

test('пустой и слишком длинный адрес отклоняются', async () => {
  await assert.rejects(() => resolveSafeTarget(''));
  await assert.rejects(() => resolveSafeTarget('https://example.com/' + 'a'.repeat(2100)));
});

test('isSafeUrl не бросает исключение, а отвечает да или нет', async () => {
  assert.equal(await isSafeUrl('http://127.0.0.1/'), false);
  assert.equal(await isSafeUrl('не адрес вообще'), false);
});

test('перенаправление на внутренний адрес не выполняется', async () => {
  // Сервер отвечает 302 на петлевой адрес: ровно то, что делает злоумышленник, чтобы
  // заставить наш сервис сходить внутрь сети и принести ему ответ.
  const evil = createServer((req, res) => {
    if (req.url === '/secret') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>внутренняя страница</title></head><body>секрет</body></html>');
      return;
    }
    res.writeHead(302, { location: '/secret' });
    res.end();
  });
  evil.listen(0, '127.0.0.1');
  await once(evil, 'listening');
  const port = evil.address().port;

  try {
    // Проверку передаём ту же, что и публичная витрина. Сам стартовый адрес петлевой,
    // поэтому проверку на входе не делаем: интересует именно поведение на переходе.
    const result = await auditSite(`http://127.0.0.1:${port}/`, {
      maxPages: 1,
      lighthouse: false,
      guard: assertSafeUrl
    });

    const page = result.pages[0];
    assert.ok(page, 'страница не обойдена вообще');
    assert.ok(!String(page.html).includes('секрет'),
      'содержимое внутренней страницы попало в результат: переход по перенаправлению не проверен');
    assert.equal(page.ok, false, 'переход должен закончиться ошибкой, а не успехом');
  } finally {
    evil.close();
  }
});

test('без проверки переход выполняется: тест ловит именно защиту, а не случайность', async () => {
  // Контрольный опыт. Если этот тест начнёт падать, значит переход по перенаправлению
  // сломался сам по себе, и предыдущий тест перестал что-либо доказывать.
  const site = createServer((req, res) => {
    if (req.url === '/final') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Конечная</title></head><body>дошли</body></html>');
      return;
    }
    res.writeHead(302, { location: '/final' });
    res.end();
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const port = site.address().port;

  try {
    const result = await auditSite(`http://127.0.0.1:${port}/`, { maxPages: 1, lighthouse: false });
    const page = result.pages[0];
    assert.equal(page.ok, true, 'без проверки переход должен пройти');
    assert.ok(String(page.html).includes('дошли'), 'страница после перенаправления не прочитана');
    assert.ok(page.finalUrl.endsWith('/final'), `конечный адрес не записан: ${page.finalUrl}`);
    assert.equal(page.redirectChain.length, 1, 'цепочка переходов не записана');
  } finally {
    site.close();
  }
});

test('петля перенаправлений обрывается, а не крутится вечно', async () => {
  const loop = createServer((req, res) => {
    res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' });
    res.end();
  });
  loop.listen(0, '127.0.0.1');
  await once(loop, 'listening');
  const port = loop.address().port;

  try {
    const result = await auditSite(`http://127.0.0.1:${port}/a`, { maxPages: 1, lighthouse: false });
    const page = result.pages[0];
    assert.equal(page.ok, false, 'петля должна закончиться ошибкой');
    const text = (page.checks ?? []).map((c) => c.message).join(' ');
    assert.match(text, /перенаправлен/i, `причина не названа: ${text}`);
  } finally {
    loop.close();
  }
});
