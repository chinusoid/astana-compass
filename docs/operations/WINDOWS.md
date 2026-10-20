# Запуск и проверки на Windows

Команды выполняются в PowerShell **7+** (`pwsh`) из корня восстановленного репозитория, рядом с `pyproject.toml`. Нужны Git, Python 3.12, uv **0.13.1**, Node.js **24.19.0** и pnpm **11.25.0** на `PATH`. `node_modules` и `.venv` с Linux не переносятся: скрипты устанавливают зависимости из `uv.lock` и `apps/web/pnpm-lock.yaml`.

Актуальная ветка Git содержит полный исходный код и готовый каталог. Достаточно клонировать её и установить зависимости по lockfiles; отдельный архив переноса не нужен. Основной путь запуска также описан в [руководстве разработки](../DEVELOPMENT.md).

## Один запуск API и интерфейса

```powershell
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode fixture -LlmProvider none
```

Скрипт [dev.ps1](../../scripts/dev.ps1) выполнит locked Python sync, frozen frontend install, подготовит MapLibre workers и запустит:

- интерфейс — `http://127.0.0.1:3000/`;
- API и Swagger — `http://127.0.0.1:8000/docs`.

Он ждёт readiness API и ответ интерфейса, затем остаётся в терминале. **Ctrl+C** останавливает только два запущенных им процесса и их дочерние процессы. Если один сервис завершится или startup не удастся, второй также будет остановлен. По имени процесса или занятому порту чужие сервисы не завершаются. Принудительное уничтожение самого PowerShell/выключение терминала не даёт той же гарантии выполнения `finally`; для обычной остановки используйте Ctrl+C. Идентификаторы собственных процессов выводятся после успешного старта.

Другие порты и запуск после уже выполненной установки:

```powershell
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode fixture -LlmProvider none -ApiPort 18081 -WebPort 13000 -SkipInstall
```

`-SkipInstall` пропускает только установку зависимостей; он не создаёт отсутствующие `.venv`/`node_modules`. Не используйте одновременно dev/build/check в одном checkout: Next.js использует его `.next`. Для независимых запусков нужны отдельный checkout и свободные порты. Launcher проверяет порты перед установкой и не выбирает другой порт незаметно.

Параметры:

| Параметр | Назначение |
| --- | --- |
| `-Mode fixture` / `live` | Набор данных API; frontend разрешает synthetic-ответы только в fixture |
| `-ApiPort` / `-WebPort` | Разные loopback-порты, по умолчанию 8000/3000 |
| `-MapProvider openfreemap` / `osm` / `none` | Подложка; по умолчанию OpenFreeMap с 3D при поддержке браузером |
| `-LlmProvider none` / `openai` / `nvidia` | Явное переопределение серверного inference; без параметра используется окружение/явный env-файл и серверный default `none` |
| `-EnvFile .env.local` | Загрузить указанный файл только для API через `uv run --env-file` |
| `-SkipInstall` | Пропустить установку уже имеющихся зависимостей |
| `-ReadyTimeoutSeconds 120` | Время ожидания каждого сервиса; default 90 секунд |

Приложение браузерное. Launcher слушает только `127.0.0.1`; это адрес текущего компьютера, он не открывает доступ с телефона. Публичный HTTPS или доступный устройству адрес настраиваются отдельно. Камера/GPS на физическом телефоне и native/offline-приложение этим запуском не подтверждаются.

## Реальные POI и live-режим

Автоматический сбор данных выполняется отдельной командой data-модуля, перед запуском API. Веб-запрос пользователя не должен запускать импорт. Нужен существующий валидный snapshot, созданный импортёром и содержащий source/provenance; произвольный JSON или synthetic fixtures не заменяют реальный набор.

В комплект входит готовый snapshot из **682 реальных OSM POI** с сохранённой атрибуцией и дополнительными сведениями из официальных источников. Источник — © OpenStreetMap contributors, [ODbL 1.0](../../data/samples/README.md). Это ограниченный каталог, а не полный охват города; время загрузки не является проверкой каждого факта. Актуальное покрытие и ограничения описаны в [отчёте данных](../data/README.md).

Команда для отдельного обновления ограниченного snapshot:

```powershell
uv run --locked --no-env-file python -m astana_city_data.importer --output data/samples/astana-osm-updated.json --cache data/samples/astana-overpass-updated-cache.json --manifest data/manifests/astana-osm-updated.json --limit 1000
```

Она отдельно создаёт новый POI snapshot, cache и manifest, не заменяя включённый в Git обогащённый каталог; повторный запуск может использовать кэш. Перед заменой рабочего snapshot нужно отдельно воспроизвести его обогащение и проверить покрытие. Для уже подготовленного snapshot новый сетевой импорт перед каждым запуском не требуется.

Укажите полученный файл через `ASTANA_POI_PATH`:

```powershell
$env:ASTANA_POI_PATH = (Resolve-Path -LiteralPath '.\data\samples\astana-osm.json').Path
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode live -LlmProvider none
```

В live-режиме подключаются установленные `astana_city_data:create_repository`, `astana_retrieval:create_retriever` и `astana_city_context:create_context` через существующую composition root. При отсутствии или повреждении snapshot либо неготовности API запуск завершается с ошибкой; скрытого перехода к трём synthetic POI нет. После изменения snapshot API нужно перезапустить: repository загружает его один раз. По умолчанию данные старше семи дней показываются как `stale`; это не попытка автоматически обновить источник.

Retriever использует BM25 и ограниченный словарь RU/KK/EN по ближайшей выборке; semantic embeddings, vector DB и собственное обучение отсутствуют. Он сохраняет provenance и не объявляет unknown required выполненным. Лексическое совпадение категории не подтверждает удобства конкретного места. [Ранжирование и настройки](../../packages/retrieval/README.md), [отдельные synthetic-eval и smoke реального snapshot](../retrieval/QUALITY.md).

После запуска проверьте `/api/v1/data-status` и `/api/v1/places` через frontend или соответствующие `/v1/...` на API: должен быть live-режим, непустой каталог и реальные источники. Дата загрузки не доказывает актуальность каждого факта. Режим `live` сам по себе не подтверждает качество рекомендаций, доступность мест, работающую hosted-модель или маршрутизацию.

`-LlmProvider none` оставляет детерминированные объяснения и rules-разбор намерения. Для реальных пеших маршрутов используются серверные `ROUTING_API_KEY`/`ORS_API_KEY`; без них допустим явно подписанный approximate-расчёт с `geometry=null`. Реальные пробки — отдельный TomTom adapter с `TOMTOM_API_KEY`. Погодный adapter включается через `ASTANA_WEATHER_ENABLED=true` отдельно после проверки условий источника.

## Серверные ключи и env-файл

Launcher не выполняет содержимое `.env`, не использует `Invoke-Expression` и не делает dot-source файла. Без `-EnvFile` API запускается с `uv run --no-env-file`: настройки берутся из обычного окружения процесса. Для явно переданного файла используется встроенная загрузка uv; отдельный `python-dotenv` не требуется.

1. Скопируйте `.env.example` в локальный `.env.local` и отредактируйте значения на своём компьютере. Файл игнорируется Git; ключи не отправляйте в чат и не добавляйте в commit.
2. Для OpenAI/NVIDIA задайте `LLM_PROVIDER`, доступный вашему аккаунту `LLM_MODEL` и `OPENAI_API_KEY` либо `NVIDIA_API_KEY` (возможен `LLM_API_KEY`). Для live-данных задайте `ASTANA_POI_PATH` с фактическим snapshot.
3. Запустите, например:

```powershell
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode live -EnvFile .env.local -LlmProvider openai
```

Параметры launcher задают режим, порты и frontend API URL в окружении дочерних процессов; переменные окружения имеют приоритет над значениями env-файла. `-LlmProvider none` явно отключает hosted inference даже при ключе в файле. `-EnvFile` передаётся только API; Next.js сохраняет стандартное поведение собственных env-файлов внутри `apps/web`. Секретные настройки не должны иметь префикс `NEXT_PUBLIC_`.

Перед кнопкой разбора UI объясняет, что при подключённом внешнем ИИ текст и язык отправятся настроенному OpenAI/NVIDIA. Фото, чат и геокоординаты автоматически не добавляются; личные сведения, написанные в самом тексте, отправятся вместе с ним. Предложения условий применяются после отдельного подтверждения. Наличие ключа или успешных MockTransport-тестов не подтверждает доступность выбранной модели: live smoke проводится отдельно.

## Полный локальный набор проверок

```powershell
pwsh -NoProfile -File .\scripts\check.ps1
```

[check.ps1](../../scripts/check.ps1) прекращает работу на первой ошибке и возвращает неуспех. Он последовательно выполняет:

1. `uv sync --locked --all-packages` и Python tests.
2. Самопроверку HTTP smoke-клиента, canonical fixtures, `generate_contracts.py --check`, Ruff.
3. `npm ci` и shared TypeScript check из изолированного `.github/typescript`.
4. Проверку JavaScript sandbox.
5. `pnpm install --frozen-lockfile`, frontend/E2E typecheck, lint, unit tests и production build.

На время проверок устанавливаются fixture-режим, `LLM_PROVIDER=none`, отключённая погода, подложка `none` и `UV_NO_ENV_FILE=1`. После завершения скрипт восстанавливает изменённые переменные окружения вызывающей PowerShell-сессии. Никаких ключей или значений env-файлов он не выводит. Установка зависимостей требует сети, если пакеты ещё не закэшированы.

Если `npm` отсутствует на `PATH`, скрипт использует зафиксированный fallback без глобальной установки:

```powershell
pnpm dlx npm@11.6.2 ci --prefix .github/typescript --ignore-scripts --no-audit --no-fund
pnpm dlx npm@11.6.2 run --prefix .github/typescript check
```

`check.ps1` не запускает постоянные серверы, browser E2E или платные/live-provider запросы. Успешный локальный запуск не означает зелёный GitHub CI.

## Отдельные сквозные проверки

Для HTTP smoke запустите fixture API через `dev.ps1`, затем во втором терминале:

```powershell
uv run --locked --no-env-file python scripts/smoke.py --base-url http://127.0.0.1:8000
```

Порт должен совпадать с `-ApiPort`. Этот smoke проверяет synthetic-интеграцию и не измеряет качество городского датасета.

Browser E2E использует отдельные production webServer-процессы на 43103/43104, текущий production build и fixture API. Не запускайте его одновременно с Next dev в том же checkout. После остановки `dev.ps1` API можно запустить отдельно в первом терминале:

```powershell
$env:ASTANA_MODE = 'fixture'
$env:LLM_PROVIDER = 'none'
uv run --locked --no-env-file uvicorn astana_api.app:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

Во втором терминале после успешного `check.ps1`:

```powershell
$env:ASTANA_API_URL = 'http://127.0.0.1:8000'
pnpm --dir apps/web exec playwright install chromium
pnpm --dir apps/web test:e2e
```

Для уже запущенного frontend с реальными данными — отдельный opt-in smoke:

```powershell
$env:ASTANA_LIVE_WEB_URL = 'http://127.0.0.1:3000'
pnpm --dir apps/web test:live
```

Не указывайте fixture-сервер в `ASTANA_LIVE_WEB_URL`. Отчёт должен различать unit, fixture HTTP/E2E, реальный POI smoke, внешние providers и remote CI. Команды в этом документе являются инструкцией запуска, а не утверждением, что все они уже успешно выполнены на вашем компьютере.
