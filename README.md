# uCoz SEO Audit & Fix MVP

MCP MVP для идеи 17: агент сканирует сайт, приоритизирует SEO-проблемы и готовит безопасные исправления для uCoz.

## MCP запуск без ручной установки

Пользователю достаточно добавить сервер в Codex/Cursor/Claude: пакет будет скачан и запущен автоматически через `npx`.

Codex:

```toml
[mcp_servers.ucoz-seo-audit-fix]
command = "npx"
args = ["-y", "--package", "github:linuxsoid/ucoz-seo-audit-fix", "ucoz-seo-audit-mcp"]
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
        "github:linuxsoid/ucoz-seo-audit-fix",
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

Отдельные архивы на сайте больше не публикуются: копия не обновляется вместе с кодом и
быстро начинает отдавать устаревшую версию. Если нужен архив, берите его у GitHub, он
собирается из текущей ветки в момент скачивания и устареть не может:
https://github.com/linuxsoid/ucoz-seo-audit-fix/archive/refs/heads/main.zip

Запуск аудита через MCP stdio-клиент:

```powershell
npm run audit:mcp -- https://example.ucoz.net 10
```

## Быстрый запуск

CLI оставлен только для разработки и smoke-test:

```powershell
git clone https://github.com/linuxsoid/ucoz-seo-audit-fix.git
cd ucoz-seo-audit-fix
npm install
node .\src\cli.mjs audit https://example.ucoz.net --max-pages 25
```

Для CI можно добавить `--fail-on-critical`, тогда команда завершится с ненулевым кодом при Critical-проблемах.

Результаты сохраняются в `reports/`:

- `seo-report-*.json` - машинный отчёт;
- `seo-report-*.md` - читаемый отчёт;
- `seo-report-*.html` - простая страница для демо.

## Публичная проверка по URL (веб-витрина)

`src/web-server.mjs` поднимает публичную страницу, где посетитель вводит адрес сайта и сразу
видит список проблем. Движок аудита тот же самый, второй реализации проверок нет.

Зачем отдельно от MCP: MCP рассчитан на владельца сайта, который поставит пакет себе в Codex
или Cursor. Это узкая аудитория. Витрина ловит человека, который про MCP ещё ничего не знает,
показывает ему реальные проблемы его сайта и только потом предлагает поставить MCP, чтобы
часть из них починилась автоматически.

```bash
node src/web-server.mjs
# затем открыть http://localhost:8787/
```

Переменные окружения:

| Переменная | По умолчанию | Что делает |
| --- | --- | --- |
| `PORT` | `8787` | порт |
| `HOST` | `0.0.0.0` | интерфейс |
| `MAX_PAGES` | `8` | сколько страниц обходить, жёсткий потолок 20 |
| `RATE_LIMIT` | `5` | проверок с одного IP за окно |
| `RATE_WINDOW_MS` | `600000` | длина окна лимита |
| `MAX_CONCURRENT` | `2` | одновременных аудитов на весь сервис |
| `TRUST_PROXY` | не задан | `1`, если сервис стоит за nginx и реальный IP в `X-Forwarded-For` |
| `ALLOW_PRIVATE` | не задан | `1` снимает защиту от приватных адресов, только для локальной отладки |

API для встраивания формы на сторонний лендинг (CORS открыт):

```bash
curl -X POST http://localhost:8787/api/audit   -H 'content-type: application/json'   -d '{"url":"mysite.ucoz.net"}'
```

Ответ содержит `summary`, сгруппированный по кодам список `issues` и краткую разбивку `pages`.

### Что защищено в публичном режиме

Публичный эндпоинт принимает произвольный адрес от анонимного посетителя, поэтому в нём есть
ограничения, которых нет и не должно быть в CLI:

- **Защита от SSRF.** Имя хоста резолвится, и адрес отклоняется, если он ведёт на петлю,
  в приватную сеть, в link-local (включая `169.254.169.254`, метаданные облака), в CGNAT или
  в multicast. Проверять строку `localhost` недостаточно: любой домен можно направить на
  `127.0.0.1`.
- Разрешены только схемы `http` и `https` и только порты 80 и 443, иначе сервис превращается
  в сканер портов чужой сети.
- Адрес с логином и паролем отклоняется.
- Лимит по IP, глобальный лимит параллельных аудитов и потолок числа страниц.
- Lighthouse в публичном режиме не запускается: он поднимает Chrome, это сотни мегабайт и
  десятки секунд на запрос. Lighthouse остаётся в MCP-режиме, где проверку делает владелец.

## Remote MCP: подключение одним URL

`src/mcp-http.mjs` отдаёт тот же набор тулов по HTTP (транспорт Streamable HTTP). Сервис
крутится на нашей стороне, пользователь вставляет в Codex, Cursor или Claude один адрес и
ничего не устанавливает: ни Node, ни пакета, ни Chrome.

Эндпоинт монтируется прямо в `web-server.mjs`, поэтому на хостинге получается один
Node-апп и один домен: `/` витрина для людей, `/mcp` для агентов.

```bash
MCP_HOSTED=1 npm run web
# витрина  http://localhost:8787/
# MCP      http://localhost:8787/mcp
```

Подключение занимает одну строку, ставить нечего.

```bash
# Claude Code
claude mcp add --transport http ucoz-seo-audit https://ваш-домен/mcp

# Grok Build
grok mcp add --transport http ucoz-seo-audit https://ваш-домен/mcp
```

Grok Bot принимает тот же адрес. Он подключает только серверы, доступные из
интернета, локальные и слушающие на localhost не берёт, поэтому туннель не нужен.

ChatGPT в режиме Codex, файл `~/.codex/config.toml`:

```toml
[mcp_servers.ucoz-seo-audit]
url = "https://ваш-домен/mcp"
```

Cursor, файл `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "ucoz-seo-audit": { "url": "https://ваш-домен/mcp" } } }
```

Официальный uCoz MCP это отдельный продукт платформы, для аудита он не нужен. Он
понадобится, только если хотите автоматические правки в шаблонах. Инструкцию у себя
сознательно не дублируем, она живёт на стороне uCoz:
https://www.ucoz.ru/help/tools/podklyuchenie-mcp-ucoz

| Переменная | Что делает |
| --- | --- |
| `MCP_TOKEN` | если задан, требуется `Authorization: Bearer <token>` |
| `MCP_ALLOW_ORIGIN` | список разрешённых `Origin` через запятую или `*`. Обычные MCP-клиенты `Origin` не шлют и работают всегда, проверка нужна против DNS rebinding из браузера |
| `MCP_HOSTED` | `1` для нашего хостинга |

### Чем удалённый режим отличается от локального

`MCP_HOSTED=1` меняет две вещи, и обе по делу:

1. Из списка убираются `run_lighthouse_audit` и `fix_template_file`. Первому нужен
   локальный Chrome, второй пишет в файловую систему пользователя, а на нашем сервере её
   нет. Показывать тул, который всегда падает, хуже, чем не показывать его вовсе.
2. Отчёт возвращается текстом прямо в ответе, а не путём к файлу. Путь вида
   `/app/reports/seo-report.json` на нашем диске пользователю бесполезен.

Для полного набора, включая Lighthouse и запись в локальные файлы, пакет ставится
локально по stdio, как описано выше.

## Развёртывание на своём сервере

На серверных скриптах uCoz работает всё, кроме Lighthouse: в том окружении нет браузера.
Полный набор, включая Lighthouse и Core Web Vitals, поднимается на обычном сервере.

```bash
# Chrome из репозитория Google, а не chromium из Ubuntu:
# в 24.04 пакет chromium это обёртка над snap, а snap на сервере лишний
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /etc/apt/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
apt-get update && apt-get install -y google-chrome-stable

git clone https://github.com/linuxsoid/ucoz-seo-audit-fix.git /opt/ucoz-seo-audit
cd /opt/ucoz-seo-audit && npm install --omit=dev
```

Служба systemd, ключевые переменные:

```
Environment=PORT=8090
Environment=HOST=127.0.0.1
Environment=MCP_HOSTED=1
Environment=MCP_ALLOW_LIGHTHOUSE=1
Environment=TRUST_PROXY=1
Environment=CHROME_PATH=/usr/bin/google-chrome-stable
MemoryMax=1200M
```

`MemoryMax` не украшение: Lighthouse поднимает Chrome, и на небольшой машине без лимита
он способен утащить за собой соседние службы.

За nginx приложение вешается так, **без слэша в конце `proxy_pass`**: префикс приложение
снимает само, а обрезка пути ломает эндпоинт MCP.

```nginx
location /seo/ {
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 180s;
}
```

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

### Что проверяется

| Группа | Проверки |
| --- | --- |
| Индексируемость | `noindex` в мета-теге и в заголовке `X-Robots-Tag`, `robots.txt`, `sitemap.xml`, `Disallow: /` |
| Сертификат | работает ли HTTPS, доверяет ли браузер, сколько дней до окончания сертификата |
| Meta | наличие и длина title и description, дубли, viewport, lang |
| Структура | иерархия H1 до H6 без пропусков, один H1 на страницу, хлебные крошки BreadcrumbList |
| Соцпревью | Open Graph и Twitter Card |
| Разметка | JSON-LD и ошибки его разбора |
| Изображения | отсутствующие alt |
| Перелинковка | битые внутренние ссылки, цепочки редиректов, страницы без входящих ссылок, глубина вложенности |
| Доверие | телефон, почта или мессенджер на сайте |
| Аналитика | установлен ли счётчик Яндекс.Метрики или Google Analytics |
| Браузер | Lighthouse, Core Web Vitals, логи консоли, ошибки JS, сеть и вес страницы |

Служебные страницы движка в счёт не идут. Политика, соглашение, оформление заказа,
страница 404 и всё, что uKit генерирует с префиксом `__`, владелец не пишет и не
редактирует, а SEO-ценности у них нет. На живом сайте это давало 18 замечаний из 20
и пугало владельца там, где реальных проблем было две.

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

## Демо-сценарий для разработчика

```powershell
node .\src\cli.mjs audit https://site.ucoz.net --max-pages 15

node .\src\cli.mjs fix-template .\exports\AHEADER.html --title "Название сайта" --description "Краткое описание страницы"

node .\src\cli.mjs audit https://site.ucoz.net --max-pages 15
```
