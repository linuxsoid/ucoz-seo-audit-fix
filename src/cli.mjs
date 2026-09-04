#!/usr/bin/env node
import { auditSite } from './seo-audit.mjs';
import { writeReports } from './report.mjs';
import { fixTemplateFile } from './template-fix.mjs';

const args = process.argv.slice(2);
const command = args[0];

function help() {
  console.log(`uCoz SEO Audit & Fix

Использование:
  node ./src/cli.mjs audit <url> [--max-pages 25] [--format all|json|markdown|html] [--fail-on-critical]
  node ./src/cli.mjs audit <url> [--lighthouse] [--lighthouse-form-factor mobile|desktop]
  node ./src/cli.mjs fix-template <file.html> [--title "..."] [--description "..."]

Примеры:
  node ./src/cli.mjs audit https://example.ucoz.net --max-pages 20
  node ./src/cli.mjs fix-template ./AHEADER.html --title "Мой сайт" --description "Краткое описание сайта"
`);
}

function getFlag(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

if (!command || command === '--help' || command === '-h') {
  help();
  process.exit(0);
}

if (command === 'audit') {
  const url = args[1];
  if (!url) {
    help();
    process.exit(1);
  }

  const maxPages = Number(getFlag('--max-pages', 25));
  const format = String(getFlag('--format', 'all'));
  const failOnCritical = args.includes('--fail-on-critical');
  const withLighthouse = args.includes('--lighthouse');
  const lighthouseFormFactor = String(getFlag('--lighthouse-form-factor', 'mobile'));
  const started = Date.now();
  const result = await auditSite(url, { maxPages, lighthouse: withLighthouse, lighthouseFormFactor });
  const files = await writeReports(result, { format });

  console.log(`Проверено страниц: ${result.pages.length}, время: ${((Date.now() - started) / 1000).toFixed(1)}с`);
  console.log(`Критичные: ${result.summary.critical}, рекомендации: ${result.summary.recommended}, успешные проверки: ${result.summary.passed}`);
  for (const file of files) console.log(`Отчёт: ${file}`);
  process.exit(failOnCritical && result.summary.critical > 0 ? 2 : 0);
}

if (command === 'fix-template') {
  const file = args[1];
  if (!file) {
    help();
    process.exit(1);
  }

  const result = await fixTemplateFile(file, {
    title: getFlag('--title', ''),
    description: getFlag('--description', '')
  });

  console.log(`Обновлён файл: ${result.file}`);
  console.log(`Backup: ${result.backup}`);
  if (result.changes.length) {
    console.log('Изменения:');
    for (const change of result.changes) console.log(`- ${change}`);
  } else {
    console.log('Безопасные изменения не требуются.');
  }
  process.exit(0);
}

help();
process.exit(1);
