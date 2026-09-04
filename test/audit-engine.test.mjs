/**
 * Тесты движка проверок.
 *
 * Здесь закреплены ошибки, каждая из которых давала ЛОЖНЫЙ вывод в отчёте, а не падение.
 * Такие хуже падений: отчёт выглядит исправным, человек ему верит и идёт чинить то, что
 * не сломано, или не видит того, что сломано.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditHtmlBundle, robotsBlocksEveryone } from '../src/seo-audit.mjs';
import { lighthouseChecksFromResult, pickTopIssues } from '../src/lighthouse-audit.mjs';
import { compareAudits } from '../src/compare-audits.mjs';

/** Одна страница, проверенная как фрагмент шаблона: движок тот же, сети не нужно. */
function checksFor(html) {
  const result = auditHtmlBundle([{ name: 'page', html }]);
  return result.checks;
}

function codes(checks) {
  return checks.filter((c) => c.severity !== 'pass').map((c) => c.code);
}

test('несколько H1 дают ровно одно замечание, а не два', () => {
  // Замечание добавлялось в двух разных местах разбора, и в сводке одна проблема
  // считалась дважды: число рекомендаций было завышено на каждой такой странице.
  const checks = checksFor('<html><head><title>Заголовок страницы тут</title></head><body><h1>Раз</h1><h1>Два</h1></body></html>');
  const multiple = checks.filter((c) => c.code === 'content.h1_multiple');
  assert.equal(multiple.length, 1, `content.h1_multiple добавлен ${multiple.length} раза`);
});

test('сводка сходится с числом проверок', () => {
  const result = auditHtmlBundle([
    { name: 'a', html: '<html><head><title>Первая страница сайта</title></head><body><h1>Раз</h1><h1>Два</h1></body></html>' },
    { name: 'b', html: '<html><head></head><body><p>Без заголовка совсем</p></body></html>' }
  ]);
  const counted = result.summary.critical + result.summary.recommended + result.summary.passed;
  assert.equal(counted, result.checks.length);
});

test('закомментированный noindex не считается запретом индексации', () => {
  // Заготовка в комментарии это не тег. Ложный critical «страница закрыта от поиска»
  // сворачивает весь остальной отчёт: смысла чинить мета-теги закрытой страницы нет,
  // и человек видит только этот блокер, которого на самом деле нет.
  const html = '<html><head><title>Обычная открытая страница</title>' +
    '<!-- <meta name="robots" content="noindex"> --></head><body><h1>Тут</h1></body></html>';
  assert.ok(!codes(checksFor(html)).includes('index.noindex'),
    'закомментированный тег принят за настоящий');
});

test('закомментированный canonical не считается заполненным', () => {
  // Обратная беда того же корня: проверка видит тег в комментарии и молчит о проблеме.
  const html = '<html><head><title>Страница без canonical</title>' +
    '<!-- <link rel="canonical" href="https://example.com/"> --></head><body><h1>Тут</h1></body></html>';
  assert.ok(codes(checksFor(html)).includes('meta.canonical_missing'),
    'тег в комментарии принят за настоящий, проблема пропущена');
});

test('настоящий noindex по-прежнему ловится', () => {
  // Контрольный опыт к двум предыдущим: если сломается сам разбор, они станут бесполезны.
  const html = '<html><head><title>Закрытая от поиска страница</title>' +
    '<meta name="robots" content="noindex"></head><body><h1>Тут</h1></body></html>';
  assert.ok(codes(checksFor(html)).includes('index.noindex'), 'настоящий noindex не найден');
});

test('блокеры индексации из Lighthouse не выбрасываются при обрезке списка', () => {
  // Обрезка живёт в summarizeLighthouse, поэтому проверяем именно её, а не готовый
  // список: прошлая версия теста кормила topIssues напрямую и обрезку не затрагивала,
  // то есть проходила независимо от наличия бага.
  // Список режется до двенадцати по величине экономии времени загрузки. У блокеров
  // индексации экономии нет вообще, поэтому они сортировались в самый конец и на сайте
  // с длинным списком рекомендаций терялись целиком.
  const noise = Array.from({ length: 20 }, (_, i) => ({
    id: `noise-${i}`,
    severity: 'recommended',
    message: `Мелочь ${i}`,
    fix: 'что-то',
    messageEn: `Minor ${i}`,
    fixEn: 'something',
    savingsMs: 5000 - i
  }));
  const blocker = {
    id: 'crawlable-anchors',
    severity: 'critical',
    message: 'Ссылки не всегда доступны поисковым роботам',
    fix: 'Используйте href',
    messageEn: 'Links are not crawlable',
    fixEn: 'Use href',
    savingsMs: 0
  };

  const audits = {};
  for (const n of noise) {
    audits[n.id] = { id: n.id, title: n.messageEn, score: 0, scoreDisplayMode: 'numeric',
      details: { overallSavingsMs: n.savingsMs } };
  }
  audits['crawlable-anchors'] = { id: 'crawlable-anchors', title: 'Links are not crawlable',
    score: 0, scoreDisplayMode: 'binary', details: {} };

  const picked = pickTopIssues(audits);
  assert.ok(picked.some((x) => x.id === 'crawlable-anchors'),
    `единственный блокер индексации выброшен вместе с мелочами. Отобрано: ${picked.map((x) => x.id).join(', ')}`);
});

test('compare_audits не считает частично исправленную проблему новой', () => {
  // Ключ сравнения включал текст сообщения, а в нём стоит число: «Найдено H1: 3» после
  // правки становится «Найдено H1: 2». Одна и та же проблема попадала сразу в оба списка,
  // и отчёт сообщал «одну исправили, одна новая» там, где стало просто лучше.
  const before = {
    summary: { critical: 0, recommended: 1, passed: 0 },
    checks: [{ severity: 'recommended', code: 'content.h1_multiple', url: 'https://a/', message: 'На странице 3 заголовков H1.' }]
  };
  const after = {
    summary: { critical: 0, recommended: 1, passed: 0 },
    checks: [{ severity: 'recommended', code: 'content.h1_multiple', url: 'https://a/', message: 'На странице 2 заголовков H1.' }]
  };

  const diff = compareAudits(before, after);
  assert.equal(diff.fixedIssues, 0,
    `проблема объявлена исправленной, хотя она осталась: ${JSON.stringify(diff.fixedIssueKeys)}`);
  assert.equal(diff.newIssues, 0,
    `та же проблема объявлена новой: ${JSON.stringify(diff.newIssueKeys)}`);
});

test('compare_audits не хвалит результат, если второй раз сайт не открылся', () => {
  // Замечаний стало меньше только потому, что проверять было нечего. Сказать «стало
  // лучше» в этом случае значит соврать в самую важную сторону.
  const before = {
    summary: { critical: 2, recommended: 5, passed: 10 },
    checks: [
      { severity: 'critical', code: 'meta.title_missing', url: 'https://a/', message: 'Нет title.' },
      { severity: 'critical', code: 'meta.description_missing', url: 'https://a/', message: 'Нет description.' }
    ]
  };
  const after = {
    summary: { critical: 1, recommended: 0, passed: 0 },
    checks: [{ severity: 'critical', code: 'page.fetch_failed', url: 'https://a/', message: 'Страница не открывается.' }]
  };

  const diff = compareAudits(before, after);
  const verdict = String(diff.verdict ?? '');
  assert.ok(!/лучше/i.test(verdict),
    `вердикт хвалит результат, хотя сайт не открылся: ${verdict}`);
});

test('символ больше внутри значения атрибута не обрезает тег', () => {
  // Разбор берёт тег регуляркой до первого символа больше, поэтому title вида
  // «Цена > 1000» читался с середины, а длина считалась по обрезку.
  const html = '<html><head><title>Обычный заголовок страницы</title>' +
    '<meta name="description" content="Цена > 1000 рублей, доставка по всей стране бесплатно и быстро">' +
    '</head><body><h1>Тут</h1></body></html>';
  const result = auditHtmlBundle([{ name: 'page', html }]);
  const checks = result.checks;
  const desc = checks.find((c) => c.code.startsWith('meta.description'));
  assert.ok(desc, 'проверка description не выполнена вообще');
  assert.notEqual(desc.code, 'meta.description_missing',
    'description с символом больше внутри значения принят за отсутствующий');
  // Значение должно быть прочитано целиком, а не до символа больше. Иначе длина
  // считается по обрезку, и человек получает замечание про короткое описание там,
  // где оно нормальной длины.
  assert.ok(!/^meta\.description_length$/.test(desc.code) || desc.message.includes('доставка'),
    `значение прочитано не целиком: ${desc.message}`);
});

test('запрет в robots.txt для одного бота не считается закрытием всего сайта', () => {
  // Владельцы закрывают сайт от сканеров конкурентов, и это обычная практика. Мы же
  // объявляли такой сайт полностью закрытым от индексации, ставили критичный блокер и
  // сворачивали весь остальной отчёт: человек видел только ложную тревогу и ничего больше.
  const NL = '\n';
  const cases = [
    ['User-agent: *' + NL + 'Disallow: /', true, 'закрыт для всех'],
    ['User-agent: AhrefsBot' + NL + 'Disallow: /' + NL + NL + 'User-agent: *' + NL + 'Allow: /', false, 'закрыт только один сканер'],
    ['User-agent: SemrushBot' + NL + 'Disallow: /', false, 'закрыт один сканер, блока для всех нет'],
    ['User-agent: *' + NL + 'Disallow: /admin/', false, 'закрыт только раздел'],
    ['User-agent: *' + NL + 'Disallow: /' + NL + 'Allow: /', false, 'полный запрет снят Allow'],
    ['# Disallow: /' + NL + 'User-agent: *' + NL + 'Disallow: /admin/', false, 'запрет только в комментарии'],
    ['User-agent: Yandex' + NL + 'User-agent: *' + NL + 'Disallow: /', true, 'два агента одним блоком'],
    ['', false, 'пустой файл'],
    ['Disallow: /', false, 'запрет без указания агента вообще']
  ];

  for (const [text, expected, why] of cases) {
    assert.equal(robotsBlocksEveryone(text), expected, why);
  }
});

test('порядок строк User-agent не меняет ответ', () => {
  // Группа это несколько строк User-agent подряд и правила после них: правила действуют
  // на всех перечисленных агентов, в каком бы порядке те ни стояли.
  const NL = '\n';
  assert.equal(robotsBlocksEveryone('User-agent: *' + NL + 'User-agent: Yandex' + NL + 'Disallow: /'), true,
    'звёздочка первой в группе');
  assert.equal(robotsBlocksEveryone('User-agent: Yandex' + NL + 'User-agent: *' + NL + 'Disallow: /'), true,
    'звёздочка второй в группе');
  // А вот здесь звёздочка в ДРУГОЙ группе, и запрет к ней не относится.
  assert.equal(robotsBlocksEveryone('User-agent: Yandex' + NL + 'Disallow: /' + NL + 'User-agent: *' + NL + 'Disallow: /admin/'), false,
    'запрет в чужой группе');
});
