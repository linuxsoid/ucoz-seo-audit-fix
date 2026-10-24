/**
 * Проверки «гигиены» сайта: зеркала, смешанное содержимое, canonical на чужой домен,
 * страницы почти без текста.
 *
 * Каждая проверка закреплена парой: случай, где замечание обязано появиться, и
 * контрольный, где его быть не должно. Контрольные взяты из первого прогона по живым
 * сайтам, где проверки шумели: страницы входа и регистрации, закрытые от поиска
 * страницы, поддомены конструктора, фрагменты шаблона без адреса.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { auditHtmlBundle, auditThinContent, mirrorHostFor, probeMirror } from '../src/seo-audit.mjs';

function codesFor(item) {
  return auditHtmlBundle([item]).checks.filter((c) => c.severity !== 'pass').map((c) => c.code);
}

const head = (extra = '') => `<html><head><title>Страница</title>${extra}</head>`;

test('canonical на другой домен это критичное замечание', () => {
  const html = `${head('<link rel="canonical" href="https://old-site.at.ua/">')}<body></body></html>`;
  assert.ok(codesFor({ url: 'https://site.ru/', html }).includes('meta.canonical_foreign'));
});

test('canonical на свой же адрес с www или без замечания не даёт', () => {
  const html = `${head('<link rel="canonical" href="https://www.site.ru/page">')}<body></body></html>`;
  assert.ok(!codesFor({ url: 'https://site.ru/page', html }).includes('meta.canonical_foreign'));
  const relative = `${head('<link rel="canonical" href="/page">')}<body></body></html>`;
  assert.ok(!codesFor({ url: 'https://site.ru/page', html: relative }).includes('meta.canonical_foreign'));
});

test('у фрагмента шаблона без адреса canonical не с чем сравнить', () => {
  // Без этого подставной адрес example.ucoz.net давал бы блокер на любом шаблоне с
  // вписанным адресом своего же сайта.
  const html = `${head('<link rel="canonical" href="https://site.ru/">')}<body></body></html>`;
  assert.ok(!codesFor({ name: 'Главная', html }).includes('meta.canonical_foreign'));
});

test('смешанное содержимое: скрипты, стили и картинки по http на странице https', () => {
  const html = `${head('<link rel="stylesheet" href="http://cdn.example/s.css">')}<body>` +
    '<script src="http://cdn.example/a.js"></script><img src="http://cdn.example/p.jpg" alt="">' +
    '<a href="http://partner.example/">ссылка не загрузка</a>' +
    '<!-- <script src="http://old.example/x.js"></script> --></body></html>';
  const check = auditHtmlBundle([{ url: 'https://site.ru/', html }]).checks.find((c) => c.code === 'security.mixed_content');
  assert.ok(check, 'замечание должно быть');
  assert.deepEqual(check.resources.sort(), ['http://cdn.example/a.js', 'http://cdn.example/p.jpg', 'http://cdn.example/s.css']);
});

test('на странице по http смешанного содержимого не бывает', () => {
  const html = `${head()}<body><script src="http://cdn.example/a.js"></script></body></html>`;
  assert.ok(!codesFor({ url: 'http://site.ru/', html }).includes('security.mixed_content'));
});

const words = (n) => Array.from({ length: n }, (_, i) => `слово${i}`).join(' ');
const livePage = (url, body, headExtra = '') => ({ url, ok: true, html: `${head(headExtra)}<body>${body}</body></html>` });

test('страница почти без текста получает замечание', () => {
  const [check] = auditThinContent(livePage('https://site.ru/uslugi', `<p>${words(12)}</p>`));
  assert.equal(check?.code, 'content.thin');
  assert.equal(check.words, 12);
});

test('скрипты и стили в счёт слов не идут', () => {
  const body = `<p>${words(10)}</p><script>${words(500)}</script><style>${words(500)}</style>`;
  assert.equal(auditThinContent(livePage('https://site.ru/a', body)).length, 1);
});

test('страница с текстом, вход, регистрация и закрытая от поиска не считаются пустыми', () => {
  assert.equal(auditThinContent(livePage('https://site.ru/a', `<p>${words(80)}</p>`)).length, 0);
  assert.equal(auditThinContent(livePage('https://site.ru/login', '<p>Вход</p>')).length, 0);
  assert.equal(auditThinContent(livePage('https://site.ru/index/1', '<input type="password" name="p">')).length, 0);
  assert.equal(auditThinContent(livePage('https://site.ru/a', '<p>Пусто</p>', '<meta name="robots" content="noindex">')).length, 0);
});

test('адрес-зеркало с www проверяется только у настоящих доменов', () => {
  assert.equal(mirrorHostFor('site.ru'), 'www.site.ru');
  assert.equal(mirrorHostFor('www.site.ru'), 'site.ru');
  assert.equal(mirrorHostFor('shop.com.ru'), 'www.shop.com.ru');
  // Поддомен конструктора: адрес с www у него никто не набирает.
  assert.equal(mirrorHostFor('seoaudit.ucoz.net'), null);
  assert.equal(mirrorHostFor('127.0.0.1'), null);
});

async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

test('зеркало, которое открывается само, это дубль, а перенаправление на основной норма', async () => {
  const main = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('main'); });
  const copy = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('copy'); });
  const redirect = await serve((req, res) => { res.writeHead(301, { location: `${main.base}/` }); res.end(); });
  try {
    assert.equal((await probeMirror(`${copy.base}/`, main.base, null))?.kind, 'duplicate');
    assert.equal((await probeMirror(`${redirect.base}/`, main.base, null))?.kind, 'redirects');
  } finally {
    await Promise.all([main.stop(), copy.stop(), redirect.stop()]);
  }
});

test('зеркало, которое ведёт на чужой сайт или не отвечает, молчит', async () => {
  const main = await serve((req, res) => { res.writeHead(200); res.end('main'); });
  const other = await serve((req, res) => { res.writeHead(200); res.end('other'); });
  const away = await serve((req, res) => { res.writeHead(302, { location: `${other.base}/` }); res.end(); });
  try {
    assert.equal(await probeMirror(`${away.base}/`, main.base, null), null);
    // Порт, на котором никто не слушает: зеркала просто нет.
    assert.equal(await probeMirror('http://127.0.0.1:1/', main.base, null, 2000), null);
  } finally {
    await Promise.all([main.stop(), other.stop(), away.stop()]);
  }
});
