/**
 * Проверки движка на настоящем локальном сервере.
 *
 * Часть выводов движка зависит не от разбора одной строки HTML, а от того, что реально
 * приехало по сети: код ответа, заголовки, адрес после перенаправления. Такие вещи нельзя
 * закрепить разбором готовой строки, поэтому здесь поднимается обычный http-сервер и
 * проверяется тот же код, который работает в бою.
 *
 * Тесты написаны на живые поломки, найденные прогоном по клиентским сайтам:
 *   1. Два старых адреса, ведущие перенаправлением на один раздел (один со слэшем на
 *      конце, другой без), считались двумя разными страницами, и одинаковые title с
 *      description давали ложный critical о дублях там, где дублей нет.
 *   2. Ответ без HTML-тела (500 с текстовым телом, 3xx без рабочего Location) не получал
 *      НИ ОДНОЙ проверки и попадал в отчёт как проверенный и беспроблемный.
 *
 * К первому тесту идёт контрольный опыт: настоящие дубли на разных страницах обязаны
 * по-прежнему находиться. Без него нормализация адреса могла бы схлопнуть вообще всё, и
 * первый тест проходил бы, ничего не доказывая.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { auditSite } from '../src/seo-audit.mjs';

/** Поднимает сервер на свободном порту и возвращает адрес и функцию остановки. */
async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

const page = (title) =>
  `<html><head><title>${title}</title>` +
  `<meta name="description" content="Описание страницы длиной примерно в шестьдесят символов.">` +
  `<meta name="viewport" content="width=device-width"></head>` +
  `<body><h1>${title}</h1><p>Текст страницы.</p></body></html>`;

test('две ссылки на один раздел через перенаправление не дают ложный дубль', async () => {
  // Так это и выглядит в жизни: на сайт ведут два старых адреса, и настроенные когда-то
  // 301 приводят один к /about, другой к /about/. Страница одна, а движок видел две с
  // одинаковым title и писал владельцу критичное «дублирующиеся заголовки».
  const { base, stop } = await serve((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        '<html><head><title>Главная</title>' +
        '<meta name="description" content="Главная страница сайта с описанием подходящей длины тут вот.">' +
        '</head><body><a href="/a">Старый адрес</a> <a href="/b">Второй старый адрес</a></body></html>'
      );
    }
    if (req.url === '/a') { res.writeHead(301, { location: '/about' }); return res.end(); }
    if (req.url === '/b') { res.writeHead(301, { location: '/about/' }); return res.end(); }
    if (req.url === '/about' || req.url === '/about/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page('О компании'));
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Нет</title></head><body>нет</body></html>');
  });

  try {
    const result = await auditSite(`${base}/`, { maxPages: 6 });
    // Контроль осмысленности: если обход не дошёл до обоих адресов, тест ничего не проверяет.
    const finals = result.pages.map((p) => p.finalUrl || p.url);
    assert.ok(finals.some((u) => u.endsWith('/about')) && finals.some((u) => u.endsWith('/about/')),
      `обход должен дойти до обоих написаний, дошёл до: ${finals.join(', ')}`);

    const duplicates = result.checks.filter((c) => String(c.code).endsWith('_duplicate'));
    assert.deepEqual(
      duplicates.map((c) => c.code),
      [],
      `одна страница под двумя написаниями адреса не дубль, а найдено: ${duplicates.map((c) => c.code).join(', ')}`
    );
  } finally {
    await stop();
  }
});

test('настоящие дубли по-прежнему находятся', async () => {
  // Контрольный опыт к предыдущему тесту. Без него нормализация адреса могла бы схлопнуть
  // вообще всё, и тест выше проходил бы, ничего не доказывая.
  const { base, stop } = await serve((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        '<html><head><title>Одинаковый заголовок</title>' +
        '<meta name="description" content="Одинаковое описание страницы подходящей длины для проверки.">' +
        '</head><body><a href="/second">Вторая</a></body></html>'
      );
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<html><head><title>Одинаковый заголовок</title>' +
      '<meta name="description" content="Одинаковое описание страницы подходящей длины для проверки.">' +
      '</head><body>вторая страница</body></html>'
    );
  });

  try {
    const result = await auditSite(`${base}/`, { maxPages: 5 });
    const codes = result.checks.map((c) => c.code);
    assert.ok(codes.includes('meta.title_duplicate'),
      'две разные страницы с одинаковым title обязаны попасть в отчёт как дубль');
  } finally {
    await stop();
  }
});

test('ответ без HTML-тела получает проверку кода ответа, а не тишину', async () => {
  const { base, stop } = await serve((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        '<html><head><title>Главная</title>' +
        '<meta name="description" content="Главная страница сайта с описанием подходящей длины.">' +
        '</head><body><a href="/upal">Раздел</a></body></html>'
      );
    }
    // Именно так и выглядит сломанный раздел в жизни: пятисотка с текстовым телом.
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  });

  try {
    const result = await auditSite(`${base}/`, { maxPages: 5 });
    const broken = result.pages.find((p) => p.url.endsWith('/upal'));
    assert.ok(broken, 'страница должна попасть в обход');
    assert.ok(Array.isArray(broken.checks) && broken.checks.length > 0,
      'страница без HTML-тела уходила в отчёт вообще без проверок, то есть выглядела чистой');
    assert.ok(result.checks.some((c) => c.code === 'page.bad_status' && c.url.endsWith('/upal')),
      'пятисотка обязана быть в отчёте критичной');
  } finally {
    await stop();
  }
});
