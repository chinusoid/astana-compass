# Разработка и запуск

Репозиторий содержит Next.js-интерфейс и Python API. Для оценки исходников **рабочие API-ключи не нужны**: режим `fixture` использует три синтетических места, режим `live` — включённый в репозиторий snapshot 682 реальных POI и локальный поиск. Hosted ИИ и дополнительные сервисы включаются отдельно своими серверными ключами.

[Техническое устройство](README.md) · [канонические контракты](../CONTRACTS.md) · [настройки API](../.env.example) · [настройки web](../apps/web/.env.example)

## Получить полные исходники

Для оценочной версии используйте опубликованную ветку:

```sh
git clone --branch coordinator/map-interaction https://github.com/chinusoid/astana-compass.git
cd astana-compass
```

Весь код и снимок каталога уже находятся в Git. Старый архив переноса для запуска этой версии не нужен. Секреты хостинга в исходники не входят.

## Среда

| Компонент | Версия для воспроизводимого запуска |
|---|---|
| Python | 3.12; проект также поддерживает 3.14 и проверяет обе версии в CI |
| uv | 0.13.1 |
| Node.js | 24.19.0, как в CI; минимальное требование web manifest — 22.12 |
| pnpm | 11.25.0 |
| PowerShell | 7+ для общего Windows launcher |
| Docker | Необязателен; нужен daemon и Compose plugin для контейнерного варианта |

Python-зависимости зафиксированы в [`uv.lock`](../uv.lock), frontend — в [`apps/web/pnpm-lock.yaml`](../apps/web/pnpm-lock.yaml). JavaScript `package.json` находится в `apps/web`, а не в корне. Команды установки используют существующие lockfiles; для первого запуска их не требуется пересоздавать.

Установите указанные среды из официальных дистрибутивов и добавьте в `PATH`. Если pnpm ещё не установлен при доступном npm:

```sh
npm install --global pnpm@11.25.0 --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
```

## Windows: быстрый запуск без ключей

Из корня распакованного или клонированного репозитория, в PowerShell 7:

```powershell
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode fixture -LlmProvider none
```

Launcher устанавливает locked Python workspace и frontend, подготавливает файлы MapLibre, запускает API на `127.0.0.1:8000` и web на `127.0.0.1:3000`. Откройте [http://127.0.0.1:3000/walk](http://127.0.0.1:3000/walk). Ctrl+C останавливает процессы, запущенные этим launcher; занятый чужим приложением порт не освобождается автоматически.

Для трёх синтетических POI выбирайте старт в районе `51.090, 71.420`. Они помечены как демонстрационные; реальные городские организации этот режим не изображает. Подложка OpenFreeMap требует интернета, даже если API работает без внешних провайдеров. Для работы вообще без запросов подложки добавьте `-MapProvider none`.

Если стандартные порты заняты:

```powershell
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode fixture -LlmProvider none -ApiPort 18081 -WebPort 13000
```

### Реальный каталог без hosted ИИ

```powershell
$env:ASTANA_POI_PATH = (Resolve-Path '.\data\samples\astana-osm.json').Path
$env:ROUTING_PROVIDER = 'osrm_public'
$env:ASTANA_ROUTE_ALLOW_APPROXIMATE = 'true'
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode live -LlmProvider none
```

Это включает 682 реальных записи и локальный разбор пожелания. FOSSGIS OSRM может построить пеший путь без ключа; сеть, покрытие и разрешённая нагрузка ограничены. При неуспехе разрешённая приблизительная оценка явно отличается от полноценной геометрии маршрута. Чтобы требовать именно построенный путь, задайте `ASTANA_ROUTE_ALLOW_APPROXIMATE=false`.

### Локальный файл настроек

```powershell
Copy-Item -LiteralPath .env.example -Destination .env.local
pwsh -NoProfile -File .\scripts\dev.ps1 -Mode live -EnvFile .env.local
```

В `.env.local` задавайте свои значения только локально. Параметры `-Mode` и `-LlmProvider`, если указан, задают режим запущенного процесса. Путь к snapshot разрешайте относительно корня репозитория или используйте абсолютный путь. Не отправляйте заполненный файл в GitHub. Образец содержит лишь пустые поля ключей.

## Linux / macOS: API и web в двух терминалах

Из корня, терминал 1:

```sh
ASTANA_MODE=fixture LLM_PROVIDER=none bash scripts/dev.sh
```

`scripts/dev.sh` запускает только API. Терминал 2:

```sh
cd apps/web
pnpm install --frozen-lockfile
ASTANA_API_URL=http://127.0.0.1:8000 ASTANA_ALLOW_FIXTURES=true ASTANA_MAP_PROVIDER=openfreemap pnpm dev
```

Web: [http://127.0.0.1:3000](http://127.0.0.1:3000). API Swagger: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs). Техническая страница API: `/sandbox`; это не основной Next.js-интерфейс.

Для реального каталога замените команду первого терминала:

```sh
ASTANA_MODE=live LLM_PROVIDER=none ASTANA_POI_PATH="$PWD/data/samples/astana-osm.json" ROUTING_PROVIDER=osrm_public ASTANA_ROUTE_ALLOW_APPROXIMATE=true bash scripts/dev.sh
```

Во втором терминале задайте `ASTANA_ALLOW_FIXTURES=false`. Реальный каталог не требует нового скачивания при каждом запуске. Простой `scripts/dev.sh` не загружает `.env` автоматически. Для явного env-файла используйте:

```sh
uv sync --locked --all-packages
uv run --locked --env-file .env.local uvicorn astana_api.app:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

Останавливайте каждое приложение Ctrl+C в его терминале. Для телефона `127.0.0.1` означает сам телефон: нужен доступный ему HTTPS-адрес; микрофон и геолокация также зависят от разрешений и безопасного контекста браузера.

## Подключение собственных провайдеров

Все следующие настройки относятся к **Python API**. Frontend получает только `ASTANA_API_URL`, `ASTANA_ALLOW_FIXTURES` и `ASTANA_MAP_PROVIDER`.

| Функция | Серверные настройки | Без ключа |
|---|---|---|
| OpenAI | `LLM_PROVIDER=openai`, `LLM_MODEL=gpt-6-luna`, `OPENAI_API_KEY` | `LLM_PROVIDER=none`: локальные правила и объяснения по данным |
| NVIDIA | `LLM_PROVIDER=nvidia`, доступный вашему аккаунту `LLM_MODEL`, `NVIDIA_API_KEY` | Hosted-вызовы отключены |
| OpenRouteService | `ROUTING_PROVIDER=openrouteservice`, `ROUTING_API_KEY` или `ORS_API_KEY` | Выберите `osrm_public` либо явно разрешите приблизительную оценку |
| TomTom | `TOMTOM_API_KEY`; для маршрутов `ROUTING_PROVIDER=tomtom` | Адаптер маршрутов допускает ограниченный OSRM fallback |
| 2GIS Places | `TWOGIS_API_KEY` | Каталог приложения продолжает работать; отдельные сведения 2GIS недоступны |
| Сведения о точке карты | `ASTANA_MAP_LOOKUP_ENABLED=true`, `ASTANA_MAP_LOOKUP_PROVIDER=nominatim` | Этот ограниченный вариант не требует ключа |
| Погода | `ASTANA_WEATHER_ENABLED=true`, `WEATHER_PROVIDER=open_meteo` | Выключена по умолчанию |

Модель должна быть доступна вашему ключу. Наличие строки `LLM_MODEL` не подтверждает её доступность аккаунту. Пример настройки без секретов:

```dotenv
ASTANA_MODE=live
ASTANA_POI_PATH=data/samples/astana-osm.json
LLM_PROVIDER=openai
LLM_MODEL=gpt-6-luna
OPENAI_API_KEY=
ROUTING_PROVIDER=osrm_public
ASTANA_ROUTE_ALLOW_APPROXIMATE=true
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

Пустое поле `OPENAI_API_KEY` здесь специально оставлено пустым: его нужно заполнить **в своём локальном env-файле или настройках хостинга**, прежде чем включать hosted-модель. Не помещайте ключи в `NEXT_PUBLIC_*`, исходники, URL, build arguments или примеры ответов.

По умолчанию лимит hosted-обращений — 10 в минуту и 100 в день на процесс. Счётчик общий для разбора и объяснений, сбрасывается с процессом и не является лимитом денег. Для платёжного бюджета используйте настройки своего провайдера. Разрешение доступа к публичным endpoint не означает отсутствие их условий использования и квот.

## Контейнеры

### Синтетический API

Из корня:

```sh
docker compose -f infra/compose.yaml up --build --detach --wait api
```

API опубликован только на `127.0.0.1:8000`, использует `fixture`, не требует ключей и запускается с непривилегированным UID/GID 10001. Web запускайте отдельно, как показано выше, с `ASTANA_ALLOW_FIXTURES=true`.

Остановка без удаления постоянных volumes:

```sh
docker compose -f infra/compose.yaml down
```

### API с включённым реальным snapshot

```sh
docker build --file infra/render/Dockerfile --tag astana-compass:live .
docker run --rm --publish 127.0.0.1:10000:10000 --env LLM_PROVIDER=none --env ROUTING_PROVIDER=osrm_public --env ASTANA_ROUTE_ALLOW_APPROXIMATE=true astana-compass:live
```

Web должен обращаться к `ASTANA_API_URL=http://127.0.0.1:10000`, показывать `ASTANA_ALLOW_FIXTURES=false`. Этот отдельный образ включает snapshot 682 мест и один worker. Общий `infra/Dockerfile` рассчитан на `fixture` и не содержит snapshot. Ключи не требуются для сборки обоих образов.

Профиль `database` в Compose предоставляет PostgreSQL/pgvector для дальнейшего развития. Он не нужен ни для одного quickstart выше. Его запуск сам по себе **не переключает** repository на БД и не включает vector search: приложение сейчас читает JSON и использует BM25.

## Сборка web

Из `apps/web`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Для runtime задайте `ASTANA_API_URL` и разрешение fixtures под выбранный API. `pnpm build` проверяет актуальность браузерных валидаторов и копирует нужные файлы MapLibre. Обновлять generated-файлы вручную не нужно: исходная схема — `contracts.schema.json`.

## Проверки для разработчика

Ниже перечислены команды, предусмотренные репозиторием. Этот документ не является отчётом об их выполнении на конкретном commit; смотрите фактический результат в [GitHub Actions](../.github/workflows/ci.yaml).

Полный Windows helper:

```powershell
pwsh -NoProfile -File .\scripts\check.ps1
```

POSIX helper для Python, контрактов и общего TypeScript-клиента:

```sh
bash scripts/check.sh
```

Отдельные Python-проверки из корня:

```sh
uv sync --locked --all-packages
uv run --locked pytest
uv run --locked python verify_contracts.py
uv run --locked python scripts/generate_contracts.py --check
uv run --locked ruff check --select E9,F .
```

Отдельные frontend-проверки из `apps/web`:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium webkit
pnpm test:ios
pnpm test:e2e
pnpm test:live:local
```

На Linux CI устанавливает системные зависимости браузеров через `playwright install --with-deps chromium webkit`. Браузерные сценарии имеют собственные [конфигурации](../apps/web/playwright.config.ts); fixture-сценарии требуют доступный fixture API, а `test:live:local` использует локальный реальный каталог. Значения и управление серверами смотрите в конфигурации выбранного набора, чтобы не направлять тесты на чужие текущие данные.

Контрактные изменения начинают с `contracts.schema.json`, затем выполняют `uv run --locked python scripts/generate_contracts.py` и `pnpm validators:generate` из `apps/web`. Команды с `--check` и `validators:check` только проверяют синхронизацию. Модульные проверки и CI не требуют реальных provider keys; не добавляйте их ради прохождения fixtures.

## Обновление данных

Импорт отделён от API и не выполняется при каждом поиске. Для воспроизведения включённых исходных кэшей без сети, из корня:

```sh
uv run --locked astana-import-osm --offline --cache data/samples/astana-overpass-cache.json --wikidata-cache data/samples/astana-wikidata-cache.json --official-supplement data/samples/astana-official-supplement.json --output data/samples/astana-osm.rebuilt.json --manifest data/samples/astana-osm.rebuilt.manifest.json
```

Это создаёт новые файлы, не перезаписывая действующий snapshot. Сверьте покрытие, provenance, категории и манифест перед заменой данных; для реального обновления источников используйте [описание импорта](../packages/city_data/README.md). После изменения файла API нужно перезапустить, чтобы repository загрузил новую версию. Время импорта не подтверждает часы работы или удобства на месте.

## Публикация собственного экземпляра

1. Разместите Python API по [`render.yaml`](../render.yaml) и [`infra/render/Dockerfile`](../infra/render/Dockerfile). На хостинге задайте ключи как runtime secrets; `LLM_PROVIDER=none` позволяет начать без ИИ. [Порядок настройки Render](operations/deploy-render.md).
2. Соберите Next.js для Workers: `pnpm build:cloudflare`. Задайте Worker `ASTANA_API_URL=https://<ваш-api>`, `ASTANA_ALLOW_FIXTURES=false`, `ASTANA_MAP_PROVIDER=openfreemap`. Для публикации нужна ваша авторизация Cloudflare. [Порядок настройки Cloudflare](operations/deploy-cloudflare.md).
3. На Windows при ошибке OpenNext junction можно использовать переносимый Linux artifact job `cloudflare`. Сопоставьте `build-info.json` с нужным исходным commit перед публикацией. `pnpm deploy:cloudflare` сохраняет runtime variables через `--keep-vars`.

Это Next.js Worker с серверными обработчиками и cookies, не статический export. Для Python API используется один worker, потому что социальные данные и квоты находятся в памяти процесса. Перезапуск уничтожает текущие гостевые профили, компании и чаты, даже если семидневный срок сессии ещё не истёк. Для постоянного многопользовательского сервиса сначала требуется долговременное общее хранилище.

## Если запуск не удался

| Симптом | Что проверить |
|---|---|
| Команда `uv`, `node`, `pnpm` или `pwsh` не найдена | Установку указанной среды и новый терминал с обновлённым `PATH` |
| Сообщение о занятом порте | Другие порты через `-ApiPort` / `-WebPort`; launcher не останавливает чужие приложения |
| Каталог пуст или synthetic запрещён | Совпадение `ASTANA_MODE` API и `ASTANA_ALLOW_FIXTURES` web; в live — путь к snapshot |
| ИИ не настроен | Пару provider/model и ключ в окружении именно Python API; без ключа используйте `LLM_PROVIDER=none` |
| Места есть, полного пути нет | Статус провайдера, квоту, покрытие и предупреждение о приблизительной оценке |
| Не загружается географическая подложка | Интернет и выбранный `ASTANA_MAP_PROVIDER`; режим каталога не управляет доступностью картографических тайлов |
| Ошибка сервиса с номером обращения | Сохраните request ID и безопасную категорию ошибки; не публикуйте содержимое секретов или личного чата |
