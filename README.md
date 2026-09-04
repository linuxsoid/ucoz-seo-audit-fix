# uCoz SEO Audit & Fix MVP

MCP MVP для идеи 17: агент сканирует сайт, приоритизирует SEO-проблемы и готовит безопасные исправления для uCoz.

## MCP запуск без ручной установки

Пользователю достаточно добавить сервер в Codex/Cursor/Claude: пакет будет скачан и запущен автоматически через `npx`.

Codex:

```toml
[mcp_servers.ucoz-seo-audit-fix]
command = "npx"
args = ["-y", "--package", "https://seoaudit.ucoz.net/seo-mcp/ucoz-seo-audit-fix-0.1.0.tgz", "ucoz-seo-audit-mcp"]
startup_timeout_sec = 60
```

Cursor / Claude Desktop:

```json
{
  "mcpServers": {
    "ucoz-seo-audit-fix": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "https://seoaudit.ucoz.net/seo-mcp/ucoz-seo-audit-fix-0.1.0.tgz",
        "ucoz-seo-audit-mcp"
      ]
    }
  }
}
```

Инструменты MCP:

- `audit_site` - сканирует публичный URL, возвращает summary и пути к отчётам;
- `run_lighthouse_audit` - запускает Lighthouse/Chrome, возвращает русскую сводку по Performance, SEO, Accessibility, Best Practices и сохраняет HTML/JSON отчеты;
- `plan_safe_fixes` - превращает найденные проблемы в whitelist-план auto-fix / approve / manual;
- `audit_html_bundle` - проверяет HTML, который агент получил через `read_template`, `list_modules` или `ftp_tool:read`;
- `preview_template_fix` - возвращает patched HTML и unified diff без записи на диск;
- `fix_template_file` - безопасно добавляет базовые meta-теги в локальный HTML-файл с backup.
- `compare_audits` - сравнивает состояние до/после повторной проверки;
- `ucoz_mcp_demo_workflow` - возвращает сценарий демо с официальным [`ucoz-mcp`](https://www.ucoz.ru/help/tools/podklyuchenie-mcp-ucoz).

ZIP-архив с исходниками доступен отдельно: `https://seoaudit.ucoz.net/seo-mcp/ucoz-seo-audit-fix-0.1.0.zip`.

Запуск аудита через MCP stdio-клиент:

```powershell
npm run audit:mcp -- https://example.ucoz.net 10
```

## Быстрый запуск

CLI оставлен только для разработки и smoke-test:

```powershell
cd "C:\Users\Linux\Documents\Работа\ucoz-seo-audit-fix"
node .\src\cli.mjs audit https://example.ucoz.net --max-pages 25
```

Для CI можно добавить `--fail-on-critical`, тогда команда завершится с ненулевым кодом при Critical-проблемах.

Результаты сохраняются в `reports/`:

- `seo-report-*.json` - машинный отчёт;
- `seo-report-*.md` - читаемый отчёт;
- `seo-report-*.html` - простая страница для демо.

## Что проверяет

- доступность страниц и коды ответа;
- `<title>`, `description`, дубликаты и подозрительную длину;
- наличие `h1`, `lang`, `viewport`, canonical;
- Open Graph / Twitter meta;
- JSON-LD Schema.org и ошибки парсинга;
- изображения без `alt`;
- внутренние битые ссылки;
- `robots.txt` и `sitemap.xml`.
- Lighthouse: Performance, SEO, Accessibility, Best Practices, lab metrics, тяжелые ресурсы и главные рекомендации.

## Безопасные исправления

Для живого сайта инструмент сначала должен работать в режиме отчёта. Автоматически применять стоит только whitelist:

- добавить отсутствующий `viewport`;
- добавить `og:type`;
- добавить базовые OG/Twitter meta, если есть стабильные источники title/description;
- исправить очевидные битые внутренние ссылки только после подтверждения;
- добавить JSON-LD только после проверки типа сайта.

Для локального HTML-шаблона есть команда:

```powershell
node .\src\cli.mjs fix-template .\template.html --title "Название сайта" --description "Краткое описание"
```

Она создаёт `.bak-*` рядом с файлом и добавляет только базовые meta-теги, если их нет.

## Как подключить к uCoz MCP

Для полного демо нужны два MCP-сервера рядом:

1. [`ucoz-mcp`](https://www.ucoz.ru/help/tools/podklyuchenie-mcp-ucoz) - читает/патчит шаблоны и FTP сайта.
2. `ucoz-seo-audit-fix` - делает SEO-аудит и строит safe-fix план.

Flow:

1. Через `ucoz-seo-audit-fix.audit_site` запустить аудит публичного URL.
2. Включить Lighthouse в `audit_site` или отдельно вызвать `ucoz-seo-audit-fix.run_lighthouse_audit`, чтобы агент сам снял Performance/SEO/Accessibility без ручного запуска DevTools.
3. Через `ucoz-seo-audit-fix.plan_safe_fixes` получить список safe/approve/manual действий.
4. Через `ucoz-mcp.list_modules` понять активные модули.
5. Через `ucoz-mcp.templates_tool.read_template` прочитать нужные шаблоны.
6. Через `ucoz-mcp.ftp_tool:read` прочитать robots/sitemap/статические файлы, если нужно.
7. Передать HTML в `ucoz-seo-audit-fix.audit_html_bundle`.
8. Через `ucoz-seo-audit-fix.preview_template_fix` подготовить безопасный diff без записи.
9. После approve применить точечную правку через `ucoz-mcp.templates_tool.patch_template` или `ftp_tool:write`.
10. Через `ucoz-mcp.templates_tool.validate_template` проверить шаблон.
11. Повторить `audit_site` и сравнить состояние через `compare_audits`.

## Demo flow

```powershell
node .\src\cli.mjs audit https://site.ucoz.net --max-pages 15
node .\src\cli.mjs fix-template .\exports\AHEADER.html --title "Site name" --description "Site description"
node .\src\cli.mjs audit https://site.ucoz.net --max-pages 15
```
