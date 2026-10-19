# Публикация сайта: Cloudflare + Render

Выбранная схема: существующий Next.js сайт работает в Cloudflare Workers через
OpenNext, Python API с реальным каталогом — в Render. OpenAI вызывается только
Python-сервисом. Ключ не нужен Cloudflare и не попадает в браузер.

Сначала создайте API по [инструкции Render](deploy-render.md). Убедитесь, что
`https://<service>.onrender.com/v1/health/ready` возвращает 200, а `/v1/data-status`
показывает live и 628 мест. Значение URL далее нужно без пути и завершающего `/v1`.

## Сборка и публикация

Node >=22.12 и pnpm 11.25.0. Из `apps/web`:

```sh
pnpm install --frozen-lockfile
pnpm build:cloudflare
pnpm exec wrangler login
pnpm deploy:cloudflare
```

Сборка сама не публикует сайт и не требует входа в аккаунт. Конфигурация не
создаёт R2, KV или базу данных. Первую публикацию выполняйте в выбранном аккаунте
Cloudflare, затем в Workers & Pages → astana-compass → Settings → Variables and
Secrets добавьте runtime variables:

| Имя | Значение |
| --- | --- |
| ASTANA_API_URL | HTTPS origin опубликованного Render API |
| ASTANA_ALLOW_FIXTURES | false |
| ASTANA_MAP_PROVIDER | openfreemap |

До установки `ASTANA_API_URL` запросы данных не работают. Команда публикации
использует `--keep-vars`, чтобы последующие релизы сохраняли настройки панели.
Для первой публикации можно заранее задать `ASTANA_API_URL` как Worker secret
через `pnpm exec wrangler secret put ASTANA_API_URL` (CLI спросит значение).
Это URL, не ключ OpenAI. Не добавляйте `OPENAI_API_KEY` или `NEXT_PUBLIC_*` ключи.

### Windows: готовая сборка из GitHub Actions

Нативная сборка OpenNext на Windows может завершиться ошибкой создания junction
даже после успешной сборки Next.js. Не меняйте права системы ради этого шага:
job `cloudflare` собирает приложение на Linux и проверяет готовую папку в workerd.
После успешной проверки он сохраняет artifact `astana-cloudflare-<commit SHA>`.

Скачайте artifact нужного успешного запуска CI и распакуйте всю папку, включая
скрытую `.open-next`. Проверьте `build-info.json`: `source_revision` должен совпасть
с публикуемым commit. Из распакованной папки выполните:

```sh
npx --yes wrangler@4.151.1 deploy --config wrangler.jsonc --keep-vars \
  --var ASTANA_API_URL:https://<service>.onrender.com \
  --var ASTANA_ALLOW_FIXTURES:false --var ASTANA_MAP_PROVIDER:openfreemap
```

В PowerShell используйте одну строку команды. Зависимости Next.js и Linux для
этого шага не нужны. В artifact нет ключей API; он содержит серверный bundle,
статические файлы, конфигурацию Wrangler и сведения о проверенной сборке.

Альтернатива: подключить GitHub в Cloudflare Workers Builds. Выберите ветку
`coordinator/map-interaction`, root `apps/web`, build `pnpm build:cloudflare`,
deploy `pnpm deploy:cloudflare`. Это Worker, а не статический Pages export:
приложению нужны серверные обработчики API и cookies групповых прогулок.

## Проверка публичной версии

Откройте выданный `workers.dev` адрес в обычном браузере. Дождитесь каталога,
найдите «Байтерек», откройте карточку места. Проверьте на карте линию пешего
маршрута, стрелки и описание остановки; нажмите на здание для сведений OSM.
В запросе сценария Enter запускает поиск, Shift+Enter добавляет строку.
Проверьте также «Разобрать запрос с ИИ» и последующее подтверждение условий.
Без работающего ключа остаётся явно обозначенный локальный разбор.

У Render Free есть остановка после простоя. Чтение каталога ждёт до 75 секунд;
POST не повторяется автоматически, чтобы не дублировать действие или расход ИИ.
При ошибке пользователь может повторить действие сам. Бесплатный Cloudflare
имеет лимит CPU; локальная сборка не подтверждает, что все запросы укладываются
в него. Проверьте ошибки и CPU в панели после первого деплоя. Платный тариф
не включается конфигурацией проекта.

Логи Worker отключены в конфигурации: URL может содержать поисковый запрос.
Включайте диагностику только с подходящей политикой хранения. Группы и кэши
Python API хранятся в памяти одного процесса и теряются при перезапуске.
Это ограничение тестовой публикации; для постоянных групп нужна БД.

## Официальные источники

- [OpenNext: существующий Next.js проект](https://opennext.js.org/cloudflare/get-started)
- [Переменные окружения OpenNext](https://opennext.js.org/cloudflare/howtos/env-vars)
- [Лимиты Workers](https://developers.cloudflare.com/workers/platform/limits/)
- [Render Free](https://render.com/docs/free)

Дата проверки инструкций: 19 октября 2026. Публикация и авторизация не выполнены
самим добавлением этих файлов; адреса нужно получить в аккаунтах владельца.
