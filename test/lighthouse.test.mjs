/**
 * Тесты разбора результатов Lighthouse.
 *
 * Здесь закрепляется правило важности, из-за которого отчёт однажды пугал людей на пустом
 * месте: Lighthouse ставит ноль почти всему, что не идеально, и если брать важность прямо
 * из его оценки, лишний CSS приезжает в критичные наравне с закрытым от индексации сайтом.
 * Найдено на живых сайтах: плюс двенадцать-тринадцать «критичных» на каждом.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { lighthouseChecksFromResult } from '../src/lighthouse-audit.mjs';

/** Каркас результата: категории и список аудитов, как их отдаёт наш summarizeLighthouse. */
function result({ categories = [], topIssues = [] } = {}) {
  return {
    available: true,
    url: 'https://example.ucoz.net/',
    summary: { categories, metrics: [], topIssues }
  };
}

function issue(id, severity) {
  return {
    id,
    severity,
    message: `${id} сработал`,
    fix: 'что-то сделать',
    messageEn: `${id} fired`,
    fixEn: 'do something'
  };
}

test('шум из Lighthouse не попадает в критичные', () => {
  // Это ровно те коды, которые раньше делали отчёт страшным.
  const noise = ['unused-javascript', 'unused-css-rules', 'valid-source-maps', 'deprecations',
                 'bootup-time', 'mainthread-work-breakdown', 'max-potential-fid', 'layout-shifts',
                 'landmark-one-main', 'link-name', 'heading-order'];
  const checks = lighthouseChecksFromResult(result({
    topIssues: noise.map((id) => issue(id, 'recommended'))
  }));

  const crit = checks.filter((c) => c.severity === 'critical');
  assert.deepEqual(crit, [], `в критичные попал шум: ${crit.map((c) => c.code).join(', ')}`);
  assert.equal(checks.length, noise.length, 'ни одна проверка не должна потеряться');
});

test('настоящие блокеры индексации остаются критичными', () => {
  const checks = lighthouseChecksFromResult(result({
    topIssues: [issue('crawlable-anchors', 'critical'), issue('hreflang', 'critical')]
  }));

  const crit = checks.filter((c) => c.severity === 'critical').map((c) => c.code);
  assert.deepEqual(crit.sort(), ['lighthouse.crawlable-anchors', 'lighthouse.hreflang']);
});

test('низкая оценка SEO критична, низкая производительность нет', () => {
  const checks = lighthouseChecksFromResult(result({
    categories: [
      { id: 'seo', title: 'SEO', score: 40 },
      { id: 'performance', title: 'Производительность', score: 10 },
      { id: 'accessibility', title: 'Доступность', score: 45 }
    ]
  }));

  const bySeverity = Object.fromEntries(checks.map((c) => [c.code, c.severity]));
  assert.equal(bySeverity['lighthouse.seo_low'], 'critical');
  // Медленный сайт это плохо, но в индекс он попадёт. В критичные его тащить нельзя.
  assert.equal(bySeverity['lighthouse.performance_needs_work'], 'recommended');
  assert.equal(bySeverity['lighthouse.accessibility_needs_work'], 'recommended');
});

test('оценка 90 и выше идёт в пройденные, а не в замечания', () => {
  const checks = lighthouseChecksFromResult(result({
    categories: [{ id: 'seo', title: 'SEO', score: 92 }]
  }));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].severity, 'pass');
  assert.equal(checks[0].code, 'lighthouse.seo_ok');
});

test('категория без оценки пропускается, а не превращается в ноль', () => {
  const checks = lighthouseChecksFromResult(result({
    categories: [{ id: 'pwa', title: 'PWA', score: null }]
  }));
  assert.deepEqual(checks, []);
});

test('недоступный Lighthouse не добавляет ни одной проверки', () => {
  assert.deepEqual(lighthouseChecksFromResult({ available: false, unavailable: 'не запустился' }), []);
  assert.deepEqual(lighthouseChecksFromResult(null), []);
  assert.deepEqual(lighthouseChecksFromResult(undefined), []);
});

test('у каждой проверки есть английские подписи', () => {
  // Без них английский отчёт наполовину русский, и это уже случалось дважды.
  const checks = lighthouseChecksFromResult(result({
    categories: [{ id: 'seo', title: 'SEO', score: 40 }, { id: 'performance', title: 'Производительность', score: 60 }],
    topIssues: [issue('crawlable-anchors', 'critical'), issue('unused-css-rules', 'recommended')]
  }));

  for (const c of checks.filter((x) => x.severity !== 'pass')) {
    assert.ok(c.messageEn, `${c.code}: нет messageEn`);
    assert.ok(!/[а-яёА-ЯЁ]/.test(c.messageEn), `${c.code}: messageEn на русском: ${c.messageEn}`);
    assert.ok(c.fixEn, `${c.code}: нет fixEn`);
    assert.ok(!/[а-яёА-ЯЁ]/.test(c.fixEn), `${c.code}: fixEn на русском: ${c.fixEn}`);
  }
});
