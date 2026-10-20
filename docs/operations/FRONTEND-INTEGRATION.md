# Интеграция frontend в CI

`apps/web` остаётся отдельным pnpm-проектом со своим `pnpm-lock.yaml`.
Корневой Python workspace и `packages/api_client` используются из того же checkout:
зависимость `@astana/api-client` имеет адрес `file:../../packages/api_client`.
Новый корневой JavaScript workspace для этого не нужен.

## Что проверяет workflow

Job `frontend` в `.github/workflows/ci.yaml` выполняется на `ubuntu-24.04` при
`pull_request` и push в `main`, параллельно с существующими Python, shared-client
и container jobs. У workflow сохранены `contents: read`, checkout без сохранения
Git credentials и закреплённые SHA уже используемых GitHub Actions.

Используются Node **24.19.0**, pnpm **11.25.0**, uv **0.13.1** и Python **3.12**.
pnpm устанавливается через npm с точной версией из
[официального registry](https://registry.npmjs.org/pnpm/11.25.0).
Этот pnpm требует Node >=22.13; выбранная версия Node удовлетворяет требованию.
Существующие action pins описаны в `PINS.md`.

Порядок шагов:

1. `uv sync --locked --all-packages` в корне: API и Python-зависимости replay-тестов.
2. `pnpm install --frozen-lockfile` в `apps/web`: установка без изменения lockfile.
3. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` из `apps/web`.
4. Установка Chromium, WebKit и системных библиотек через
   `pnpm exec playwright install --with-deps chromium webkit` в CI. Версию браузера
   определяет Playwright из lockfile; системный Chrome не подставляется.
5. Запуск fixture API на `127.0.0.1:8000`, ограниченное ожидание readiness,
   HTTP smoke, `pnpm test:ios` и `pnpm test:e2e`.
6. Отдельные browser-сценарии локального реального каталога — `pnpm test:live:local`.

Существующая конфигурация `playwright.config.ts` запускает все сценарии из
`tests/e2e/frontend.spec.ts` без дополнительного фильтра, включая проверки
локалей, доступности, маршрута, изменения выбранных мест и отказов генерации.
Playwright самостоятельно поднимает два **production** frontend-процесса после
сборки: `127.0.0.1:43103` разрешает fixture-данные, `127.0.0.1:43104` проверяет
их блокировку. Повторное использование посторонних серверов отключено.
API завершается shell trap после завершения или ошибки тестов.

## Режим и границы проверки

В job явно заданы `ASTANA_MODE=fixture`, `LLM_PROVIDER=none`,
`ASTANA_WEATHER_ENABLED=false`, `ASTANA_MAP_PROVIDER=none`,
`ASTANA_API_URL=http://127.0.0.1:8000` и `NEXT_TELEMETRY_DISABLED=1`.
`ASTANA_ALLOW_FIXTURES=true` разрешает показ явно синтетических данных;
отдельный frontend-процесс переопределяет его на `false` для отрицательного теста.
Значения задаются окружением CI, `.env` и provider credentials для них не нужны.

`ASTANA_E2E_PYTHON` указывает на абсолютный путь `${GITHUB_WORKSPACE}/.venv/bin/python`.
Это требуется `tests/e2e/generation_response.py`: он вызывает реальные
generator/recommender с синтетическими ответами и `httpx.MockTransport`, без
внешней inference. E2E выполняется из `apps/web`, поэтому его относительные пути
до Python helper и shared contracts разрешаются корректно.

Основная fixture-проверка использует три synthetic-места. Отдельный local-live
набор читает реальный snapshot без обращения к живым inference/routing API. Эти
проверки не подтверждают доступность
поставщиков live-данных, актуальность реальных мест, корректность платной модели
или live weather/routing. `pnpm test:live` в этот job не входит. Установка
зависимостей и браузеров требует сети, но тестовым сценариям не нужны внешние
карты, inference, ключи или публичное размещение приложения.

## Проверка и диагностика

Локальная интеграция использует Node 24.19.0, тот же закреплённый pnpm и backend
из актуального main. После review исправлены сохранение обязательных условий
при выборе готового сценария, блокировка synthetic-маркеров в источниках
маршрутов и объяснения невыполненных пожеланий у остановок итогового плана.
Регрессионные unit- и browser-тесты входят в общий pipeline.

В checks PR отдельно видны результаты frontend, Python 3.12/3.14, shared-client
и Docker. Browser suite использует один worker без retries; API readiness и
HTTP smoke проверяются до её запуска. При ошибке API выводятся последние
100 строк его журнала, access log отключён. Playwright выводит list reporter
и создаёт локальные `apps/web/playwright-report` и `apps/web/test-results`.
Workflow сохраняет browser reports и screenshots как GitHub artifacts; результат конкретного прогона проверяется по его commit SHA.

Текущее состояние CI проверяется по последнему SHA PR; сам документ описывает
конфигурацию, а не подтверждает успех ещё не завершившегося прогона.
Сводный путь запуска и проверок — в [DEVELOPMENT.md](../DEVELOPMENT.md),
пользовательская демонстрация — в [DEMO.md](../DEMO.md).
