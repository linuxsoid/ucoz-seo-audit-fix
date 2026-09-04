export function compareAudits(before, after) {
  const beforeSummary = before?.summary ?? {};
  const afterSummary = after?.summary ?? {};
  const beforeKeys = new Set((before?.checks ?? []).filter((check) => check.severity !== 'pass').map(issueKey));
  const afterKeys = new Set((after?.checks ?? []).filter((check) => check.severity !== 'pass').map(issueKey));

  const fixed = [...beforeKeys].filter((key) => !afterKeys.has(key));
  const newIssues = [...afterKeys].filter((key) => !beforeKeys.has(key));

  return {
    before: {
      critical: beforeSummary.critical ?? 0,
      recommended: beforeSummary.recommended ?? 0,
      passed: beforeSummary.passed ?? 0
    },
    after: {
      critical: afterSummary.critical ?? 0,
      recommended: afterSummary.recommended ?? 0,
      passed: afterSummary.passed ?? 0
    },
    delta: {
      critical: (afterSummary.critical ?? 0) - (beforeSummary.critical ?? 0),
      recommended: (afterSummary.recommended ?? 0) - (beforeSummary.recommended ?? 0),
      passed: (afterSummary.passed ?? 0) - (beforeSummary.passed ?? 0)
    },
    fixedIssues: fixed.length,
    newIssues: newIssues.length,
    fixedIssueKeys: fixed.slice(0, 100),
    newIssueKeys: newIssues.slice(0, 100),
    verdict: buildVerdict(beforeSummary, afterSummary, fixed.length, newIssues.length, after?.checks ?? [])
  };
}

/**
 * Ключ проблемы для сравнения двух проверок.
 *
 * Только код и адрес, без текста сообщения. В сообщении стоят числа и цитаты: «На странице
 * 3 заголовков H1» после частичной правки становится «На странице 2 заголовков H1». По
 * ключу с сообщением это две разные проблемы, поэтому одна и та же неисправленная проблема
 * попадала сразу в оба списка: и в исправленные, и в новые. Сравнение сообщало «одну
 * исправили, одна новая» там, где просто стало немного лучше.
 */
function issueKey(check) {
  return `${check.code}|${check.url}`;
}

function buildVerdict(before, after, fixedCount, newCount, afterChecks = []) {
  const criticalDelta = (after.critical ?? 0) - (before.critical ?? 0);
  const recommendedDelta = (after.recommended ?? 0) - (before.recommended ?? 0);

  // Сначала выясняем, была ли вторая проверка вообще состоятельной. Если сайт не открылся,
  // проверять было нечего, замечаний стало меньше просто потому, что их некому было найти,
  // и любое сравнение тут бессмысленно. Сказать в этом случае «стало лучше» значит соврать
  // в самую опасную сторону: человек решит, что правка помогла, и не заметит, что уронил
  // сайт. Раньше вердикт смотрел только на число критичных и говорил ровно это.
  const dead = afterChecks.some((c) => c.code === 'page.fetch_failed' || c.code === 'page.bad_status');
  const nothingChecked = (after.passed ?? 0) === 0 && (before.passed ?? 0) > 0;
  if (dead || nothingChecked) {
    return 'Сравнить не с чем: во второй раз сайт не открылся или проверка не прошла. Замечаний стало меньше только потому, что искать было негде. Проверьте, доступен ли сайт, и запустите проверку заново.';
  }
  if (criticalDelta < 0) return `Стало лучше: критичных проблем меньше на ${Math.abs(criticalDelta)}. Исправлено проверок: ${fixedCount}, новых проблем: ${newCount}.`;
  if (criticalDelta > 0) return `Стало хуже: критичных проблем больше на ${criticalDelta}. Нужно откатить или проверить diff.`;
  if (recommendedDelta < 0) return `Критичные проблемы не выросли, рекомендаций меньше на ${Math.abs(recommendedDelta)}. Исправлено проверок: ${fixedCount}.`;
  if (newCount) return `Критичные проблемы не выросли, но появились новые замечания: ${newCount}. Нужно посмотреть diff.`;
  return 'Состояние не ухудшилось, новых замечаний не появилось.';
}
