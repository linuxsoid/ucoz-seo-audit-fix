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

Результаты сохраняются в `reports/`: JSON, Markdown и HTML.

В режиме хостинга (`MCP_HOSTED=1`) на диск не пишется ничего: путь к файлу на нашем сервере
удалённому клиенту бесполезен, а каждый вызов оставлял бы там по полтора мегабайта.

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

Ответ содержит `summary`, сгруппированный по кодам список `issues`, краткую разбивку `pages`
и `sessionId`. Идентификатор нужен для второй половины проверки и для скачивания файлов.

Вторая половина, Lighthouse и браузерная диагностика. Она отделена от первой не по смыслу,
а по времени: первая часть отвечает за несколько секунд, вторая занимает около минуты, и
человеку показывают первые результаты сразу, а не пустой экран:

```bash
curl -X POST http://localhost:8787/api/deep   -H 'content-type: application/json'   -d '{"url":"mysite.ucoz.net","sessionId":"<из ответа /api/audit>"}'
```

В ответе приходит перечень файлов (`files`): имя, человеческое название и размер. Содержимого
файлов в ответе нет, и это сделано намеренно: отчёт Lighthouse и скриншот весят под мегабайт
каждый, гнать их в JSON значит утроить ответ ради того, что человек может и не скачать.

Файлы живут в той же сессии, что и результат проверки, и умирают вместе с ней через 15 минут:

```bash
# один файл
curl -OJ 'http://localhost:8787/api/file?id=<sessionId>&name=<имя из files>'
# всё сразу одним архивом
curl -OJ 'http://localhost:8787/api/bundle?id=<sessionId>'
```

Внутри архива три папки, и в каждой файл `CHITAT-SNACHALA.txt` с объяснением, что там лежит:

- `dlya-cheloveka/` отчёт в HTML, открывается двойным щелчком и выглядит как документ,
  плюс он же обычным текстом;
- `dlya-ii/` задание агенту на русском и английском плюс машинные данные проверки;
- `ishodnye-dannye/` HAR со всеми сетевыми запросами, лог консоли, скриншот страницы
  целиком и официальный отчёт Lighthouse в HTML и в JSON.

Раскладка по папкам, а не списком файлов, потому что человек без техбэкграунда не знает,
что такое HAR, и не должен выбирать между тринадцатью файлами. Архив собирается своим кодом
на `node:zlib`, зависимостей для этого нет.

Отчёт можно не скачивать, а посмотреть страницей:

```bash
curl 'http://localhost:8787/api/view?id=<sessionId>'
```

Скрипты на этой странице запрещены заголовком CSP: внутрь отчёта попадают заголовки и адреса
с проверяемого сайта, экранирование мы проверяем тестами, но одного слоя защиты для страницы
на своём домене мало.

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
| `MCP_HOSTED` | `1` принудительно включает сетевой режим. По умолчанию он и так включён для HTTP-транспорта, флаг нужен, только чтобы включить его и для stdio |
| `MCP_ALLOW_LIGHTHOUSE` | `1` открывает `run_lighthouse_audit` и `collect_browser_diagnostics` (нужен локальный Chrome) |
| `MCP_ALLOW_FS` | `1` открывает `fix_template_file`, то есть запись файлов по указанному пути |

### Чем удалённый режим отличается от локального

Режим определяет **транспорт**, а не переменная окружения. HTTP по определению значит, что
адрес прислал посторонний; stdio значит, что за клавиатурой владелец машины.

Что даёт удалённый режим:

1. **Проверка адреса и потолок страниц.** Адрес прогоняется через `resolveSafeTarget`, на
   каждый переход обхода ставится `assertSafeUrl`, а `maxPages` режется до восьми. Без
   этого `audit_site` был бы обходным путём во внутреннюю сеть: достаточно попросить
   проверить `127.0.0.1` или служебный адрес облака.
2. **Отчёт возвращается текстом**, а не путём к файлу. Путь вида
   `/app/reports/seo-report.json` на нашем диске пользователю бесполезен.

Раньше и то, и другое включалось только переменной `MCP_HOSTED=1`. Это была ошибка: между
публичным сервисом и внутренней сетью стояла человеческая память о переменной окружения.
Теперь `callTool` считает вызов сетевым по умолчанию, локальный режим включает только
stdio-транспорт, а `MCP_HOSTED=1` остался принудительным включением сетевого режима.

Отдельно от режима работает список закрытых тулов. `run_lighthouse_audit`,
`collect_browser_diagnostics` и `fix_template_file` закрыты **всегда**, потому что первым
двум нужен локальный Chrome, а третий пишет в файловую систему. Открываются они явными
переменными `MCP_ALLOW_LIGHTHOUSE=1` и `MCP_ALLOW_FS=1`.

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

## Автотесты

```bash
npm test
```

71 тест на встроенном раннере Node, без зависимостей. Что закреплено:

| Файл | Что проверяет |
| --- | --- |
| `test/zip.test.mjs` | формат ZIP разбирается обратно своим кодом по спецификации: CRC считается независимо, проверяются кириллица в именах, пустой архив и бинарь без порчи |
| `test/safe-url.test.mjs` | защита от SSRF, включая переход по перенаправлению на внутренний адрес. На настоящем локальном сервере, а не на подменённом fetch |
| `test/audit-engine.test.mjs` | ложные выводы движка: robots.txt с запретом для одного бота, теги внутри комментариев, символ `>` внутри значения атрибута, двойной счёт замечаний, классификация сертификатов |
| `test/report.test.mjs` | экранирование при враждебном содержимом с чужого сайта, полнота английского отчёта, все затронутые адреса в задании агенту |
| `test/mcp.test.mjs` | транспорт запуском настоящего процесса: битая строка, пустая строка, нотификации, `ping`, коды ошибок JSON-RPC |
| `test/lighthouse.test.mjs` | важность проверок: шум не попадает в критичные, блокеры индексации не выбрасываются при обрезке списка |
| `test/site.test.mjs` | скрипт лендинга разбирается, нет вызовов удалённых функций, шаблон uCoz собран из `index.html` |

Два теста устроены как контрольный опыт: рядом с проверкой защиты стоит проверка того, что
защищаемое действие вообще работает. Без неё тест на защиту однажды начнёт проходить просто
потому, что сломался сам механизм, и перестанет что-либо доказывать.

Шаблон страницы uCoz не редактируется руками, а собирается:

```bash
npm run build:template
```

За один день эти два файла дважды разошлись, и на живом сайте работала старая версия
скрипта. Теперь расхождение ловит тест.

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
