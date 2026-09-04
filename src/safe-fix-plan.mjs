export function planSafeFixes(auditResult) {
  // Принимаем и сам результат, и ответ audit_site целиком.
  //
  // В описании тула написано «полный результат, который вернул audit_site», и агент честно
  // передаёт весь ответ. А внутри ответа результат лежит под ключом auditResult, поэтому
  // checks на верхнем уровне не находились, и план получался пустым: тул отвечал
  // «исправлять нечего» на сайте с пятнадцатью проблемами. Молча и без ошибки.
  const source = auditResult?.checks ? auditResult : (auditResult?.auditResult ?? auditResult ?? {});
  const checks = source.checks ?? [];
  const actions = [];

  for (const check of checks) {
    const rule = classify(check);
    actions.push({
      severity: check.severity,
      code: check.code,
      url: check.url,
      issue: check.message,
      fix: check.fix ?? '',
      mode: rule.mode,
      target: rule.target,
      rationale: rule.rationale
    });
  }

  return {
    site: source.startUrl,
    scannedAt: source.scannedAt,
    summary: {
      safeAutoFix: actions.filter((action) => action.mode === 'safe_auto_fix').length,
      approveRequired: actions.filter((action) => action.mode === 'approve_required').length,
      manualOnly: actions.filter((action) => action.mode === 'manual_only').length
    },
    actions
  };
}

function classify(check) {
  if (check.severity === 'pass') {
    return {
      mode: 'no_action',
      target: 'none',
      rationale: 'Проверка уже пройдена.'
    };
  }

  const safeMetaCodes = new Set([
    'meta.viewport_missing',
    'og.og_type_missing',
    'og.og_title_missing',
    'og.og_description_missing',
    'twitter.card_missing'
  ]);

  if (safeMetaCodes.has(check.code)) {
    return {
      mode: 'safe_auto_fix',
      target: 'template_head',
      rationale: 'Детерминированные meta-теги в head можно добавить без изменения видимого контента страницы.'
    };
  }

  if (check.code === 'meta.description_missing') {
    return {
      mode: 'approve_required',
      target: 'template_or_page_meta',
      rationale: 'Description можно сгенерировать, но текст должен подтвердить владелец перед публикацией.'
    };
  }

  if (check.code === 'meta.title_missing') {
    return {
      mode: 'approve_required',
      target: 'template_or_page_title',
      rationale: 'Title влияет на отображение в поиске, поэтому текст нужно подтвердить.'
    };
  }

  if (check.code === 'links.internal_broken') {
    return {
      mode: 'approve_required',
      target: 'template_or_content_link',
      rationale: 'Битые ссылки часто можно исправить безопасно, но URL-замену нужно проверить.'
    };
  }

  if (check.code.startsWith('schema.')) {
    return {
      mode: 'approve_required',
      target: 'template_head',
      rationale: 'Тип и поля Schema.org зависят от типа сайта и конкретной страницы.'
    };
  }

  return {
    mode: 'manual_only',
    target: 'site_or_content',
    rationale: 'Эта проблема может затрагивать бизнес-логику, контент, правила индексации или структуру страницы.'
  };
}
