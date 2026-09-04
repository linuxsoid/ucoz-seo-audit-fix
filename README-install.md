# uCoz SEO Audit & Fix MCP

Публичный MCP-сервер для быстрого SEO-аудита сайтов uCoz: сканирует публичные страницы, группирует замечания по URL и шаблонам, строит безопасный план исправлений и генерирует отчеты в JSON, Markdown и HTML.

## Что умеет

| Возможность | Что делает |
| --- | --- |
| `audit_site` | Сканирует публичный сайт и создает SEO-отчет |
| `run_lighthouse_audit` | Запускает Lighthouse/Chrome и возвращает русскую сводку по Performance, SEO, Accessibility и Best Practices |
| `plan_safe_fixes` | Делит правки на safe auto-fix, approve и manual |
| `audit_html_bundle` | Проверяет HTML шаблонов, полученных через официальный `ucoz-mcp` |
| `preview_template_fix` | Показывает diff без записи |
| `compare_audits` | Сравнивает аудит до и после исправлений |

## Требования

- Node.js 20 или новее.
- Codex, Claude Desktop, Cursor или другой MCP-клиент.
- Для чтения и правки шаблонов uCoz дополнительно нужен официальный [`ucoz-mcp`](https://www.ucoz.ru/help/tools/podklyuchenie-mcp-ucoz).

## Подключение без консоли

Пользователю достаточно добавить MCP-сервер в Codex/Cursor/Claude: пакет будет скачан и запущен автоматически через `npx`.

### Codex

```toml
[mcp_servers.ucoz-seo-audit-fix]
command = "npx"
args = ["-y", "--package", "https://seoaudit.ucoz.net/seo-mcp/ucoz-seo-audit-fix-0.1.0.tgz", "ucoz-seo-audit-mcp"]
startup_timeout_sec = 60
```

### Cursor / Claude Desktop

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

Для работы с реальным uCoz-сайтом подключите рядом официальный MCP.
Если вы еще не подключали uCoz MCP, начните с официальной инструкции:
https://www.ucoz.ru/help/tools/podklyuchenie-mcp-ucoz

```toml
[mcp_servers.ucoz]
command = "npx"
args = ["-y", "ucoz-mcp@latest"]

[mcp_servers.ucoz.env]
UCOZ_API_TOKEN = "sk_live_..."
UCOZ_SITE_URL = "https://your-site.ucoz.net/"
UCOZ_FTP_HOST = "your-site.ucoz.net"
UCOZ_FTP_USER = "..."
UCOZ_FTP_PASS = "..."
```

Не публикуйте реальные токены и FTP-пароли в репозитории, ZIP-архивах, отчетах и скриншотах.

## Исходники

ZIP-архив с исходниками доступен отдельно, если нужно посмотреть или доработать код:

```text
https://seoaudit.ucoz.net/seo-mcp/ucoz-seo-audit-fix-0.1.0.zip
```

## Типовой сценарий

1. Запустить `audit_site` для публичного URL.
2. При необходимости включить Lighthouse в `audit_site` или отдельно запустить `run_lighthouse_audit`.
3. Посмотреть HTML или Markdown отчет с блоками On-page SEO, шаблоны и Lighthouse.
4. Запустить `plan_safe_fixes`.
5. Через официальный `ucoz-mcp` прочитать нужные шаблоны.
6. Передать HTML в `audit_html_bundle`.
7. Получить diff через `preview_template_fix`.
8. После явного approve применить точечную правку через `ucoz-mcp`.
9. Повторить `audit_site` и сравнить результат через `compare_audits`.

## Политика безопасности

Автоматические правки должны быть ограничены whitelist-изменениями: meta viewport, title/description при надежном источнике, OG/Twitter meta и другие детерминированные вставки. Canonical, Schema.org, редиректы и переписывание контента требуют подтверждения человека.
