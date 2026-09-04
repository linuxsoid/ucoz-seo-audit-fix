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
    verdict: buildVerdict(beforeSummary, afterSummary, fixed.length, newIssues.length)
  };
}

function issueKey(check) {
  return `${check.code}|${check.url}|${check.message}`;
}

function buildVerdict(before, after, fixedCount, newCount) {
  const criticalDelta = (after.critical ?? 0) - (before.critical ?? 0);
  const recommendedDelta = (after.recommended ?? 0) - (before.recommended ?? 0);
  if (criticalDelta < 0) return `Стало лучше: критичных проблем меньше на ${Math.abs(criticalDelta)}. Исправлено проверок: ${fixedCount}, новых проблем: ${newCount}.`;
  if (criticalDelta > 0) return `Стало хуже: критичных проблем больше на ${criticalDelta}. Нужно откатить или проверить diff.`;
  if (recommendedDelta < 0) return `Критичные проблемы не выросли, рекомендаций меньше на ${Math.abs(recommendedDelta)}. Исправлено проверок: ${fixedCount}.`;
  if (newCount) return `Критичные проблемы не выросли, но появились новые замечания: ${newCount}. Нужно посмотреть diff.`;
  return 'Состояние не ухудшилось, новых замечаний не появилось.';
}
