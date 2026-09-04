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

test('обход добирает адреса из sitemap.xml, когда ссылок на странице мало', async () => {
  // На сайтах конструкторов меню рисуется скриптом, и в исходнике страницы ссылок почти
  // нет. Замерено на живом сайте: на главной четыре внутренние ссылки, три из них на
  // картинки. Проверять было нечего, хотя страниц десятки и все они в его же sitemap.xml.
  const pages = {
    '/': '<html><head><title>Главная страница сайта тут</title></head><body>' +
         '<h1>Главная</h1><a href="/logo.png">Логотип</a></body></html>',
    '/uslugi': '<html><head><title>Услуги нашей компании</title></head><body><h1>Услуги</h1></body></html>',
    '/ceny': '<html><head><title>Цены на услуги компании</title></head><body><h1>Цены</h1></body></html>',
    '/kontakty': '<html><head><title>Контакты нашей компании</title></head><body><h1>Контакты</h1></body></html>'
  };

  const site = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/sitemap.xml') {
      const base = `http://127.0.0.1:${site.address().port}`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0"?><urlset>' +
        Object.keys(pages).map((p) => `<loc>${base}${p}</loc>`).join('') +
        `<loc>${base}/logo.png</loc>` +
        '</urlset>');
      return;
    }
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\nSitemap: /sitemap.xml');
      return;
    }
    if (path === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    const html = pages[path];
    if (!html) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');

  try {
    const result = await auditSite(`http://127.0.0.1:${site.address().port}/`, {
      maxPages: 8,
      lighthouse: false
    });
    const paths = result.pages.map((p) => new URL(p.url).pathname).sort();

    assert.deepEqual(paths, ['/', '/ceny', '/kontakty', '/uslugi'],
      `обойдены не те страницы: ${paths.join(', ')}`);
    // Картинка есть и в ссылках, и в карте сайта, но страницей не считается: проверять
    // по ней нечего, а лимит обхода она съедает наравне со страницей.
    assert.ok(!paths.includes('/logo.png'), 'картинка попала в обход как страница');
  } finally {
    site.close();
  }
});
