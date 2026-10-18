# Team 03 · фактически выполненные проверки

Дата: 19 октября 2026, Asia/Almaty. Исходная база:
`9a9747309941e7ea5ff9c338b695e2605ccbef73`. Перед публикацией интегрирован upstream
`7258917c3a5a81717639ee3d8abf2588d253f131`; итоговый браузерный прогон использовал
его настоящий foundation HTTP API. Ветка: `team/03-frontend-ux`.

## Результаты

| Проверка | Фактический результат |
| --- | --- |
| `pnpm build` из `apps/web` | Production build Next 16.4.2 / Webpack успешно |
| `pnpm typecheck` | Next route types, приложение и e2e TypeScript успешно |
| `pnpm lint` | Приложение и e2e, без ошибок и предупреждений |
| `pnpm test` | 38 тестов в 5 файлах успешно |
| `pnpm test:e2e` | 21/21 успешно, без retries, 29 секунд |
| axe в e2e | RU/KK/EN × 1440px/390px: 0 нарушений WCAG 2 A/AA и 2.1 AA в проверенных состояниях |
| `pnpm test:live` без URL | 1 явно пропущен; это не успешная live-проверка |
| `python verify_contracts.py` | 25 canonical fixtures успешно |
| `python scripts/generate_contracts.py --check` | 4 generated artifacts актуальны |
| `python scripts/smoke.py --base-url http://127.0.0.1:8000` | 8/8 HTTP-сценариев fixture API успешно |
| Ruff E9/F для `tests/e2e/generation_response.py` | Успешно |
| `pnpm peers check` | Несовместимых peer dependencies нет |
| Production OSM map smoke | 10 ответов тайлов, все HTTP 200; worker работает; fallback отсутствует |

Это локальные результаты. Состояние GitHub CI отображается отдельно в PR;
frontend-команды пока не подключены к общему CI и предложены координатору в
`docs/requests/team-03-frontend-integration.md`.

## Что именно проверено

Offline tests: canonical JSON validation и семантические инварианты, required
unknown/conflicting, ссылки evidence, synthetic guard, перестановка/потеря stops,
общий бюджет и возврат, точные секунды, Asia/Almaty при другом timezone браузера,
безопасные URL, abort и timeout в том числе во время чтения тела, ограничения proxy,
состояния и доступность карточки.

Браузерные сценарии через реальный fixture API: ручной старт, рекомендации,
источники, диалог и возврат фокуса, required unknown, весь маршрут с возвращением,
no_match с сохранением stops, явная перестановка, feedback, удаляемое избранное,
три языка, клавиатура и data-status. В тестах отказов отдельно перехватываются
ответы: clarification, rate-limit, provider error, нарушение порядка сервером,
медленный устаревший ответ, routed synthetic geometry. Approximate никогда не
показывается как линия маршрута. Отказ геолокации и поздний callback не портят
ручную точку. Запуск против fixture без opt-in не выдаёт synthetic за live.

Три сценария отказа ИИ используют настоящий `create_generator` и
`DefaultRecommendationService` координатора с `httpx.MockTransport`:
provider refusal, malformed model output, HTTP 503. Replay adapters принимают
только явно synthetic ответ foundation. Полученный canonical response проходит
обычный frontend и показывает доступное объяснение по каталогу, факты и источники.
Это тест границы и отказоустойчивости, не вызов внешней оплачиваемой модели.

Автоматический axe не заменяет аудит с пользователями screen reader. Дополнительно
проверены видимый фокус, Escape, восстановление фокуса после dialog, отсутствие
горизонтального overflow на 390px, кнопки от 44px и визуально просмотрены скриншоты.

## Live-блокер и воспроизведение

Отдельный backend с `ASTANA_MODE=live` вернул:

- `/v1/health/ready`: HTTP 503, `status=unavailable`;
- `/v1/data-status`: HTTP 503, `provider_unavailable`, режим `live`;
- в установленном locked workspace отсутствуют Python-модули
  `astana_city_data`, `astana_retrieval`, `astana_city_context`.

Нужно интегрировать согласованные factories команд 01/02 и их конфигурацию,
затем выполнить отдельный `ASTANA_LIVE_WEB_URL=… pnpm test:live` с frontend,
у которого fixtures запрещены. Текущая синтетическая интеграция не доказывает
качество реальных POI, маршрутов, расписаний или внешнего inference. Frontend
обрабатывает этот 503 и не подменяет данные.

Команды установки, сборки, env и тестов находятся в `apps/web/README.md`.
Локальная среда: Node 26.8.2, pnpm 11.25.0, Chromium `/usr/bin/chromium`, Python
из locked uv environment. Пример браузерного запуска из `apps/web`:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
ASTANA_E2E_PYTHON=/path/to/root/.venv/bin/python \
ASTANA_SCREENSHOT_DIR=/path/to/artifacts \
pnpm test:e2e
```

На этой машине Chromium запущен с разрешением вне ограниченного shell sandbox,
в одноразовом профиле, согласно родительскому AGENTS.md. Личный профиль не менялся.

## Реальные артефакты

Скриншоты сохранены вне Git в локальной папке
`/home/abilkhayr/Work/hakers/astana-compass-team03-artifacts/`:

- `frontend-desktop.png`, `frontend-mobile.png`: реальный production UI, OSM map;
- `ru-1440.png`, `ru-390.png`, `kk-1440.png`, `kk-390.png`, `en-1440.png`,
  `en-390.png`: результаты с явно synthetic данными, 6 сочетаний языка/размера;
- `ru-desktop-results.png`: рекомендации и источники;
- `synthetic-routed.png`: только тестовая геометрия с synthetic-маркировкой;
- `playwright-report/`: HTML-отчёт итогового успешного прогона.

Это локальные артефакты передачи пользователю, не публичные URLs. Reviewer может
воспроизвести их указанной командой; координатору предложено сохранять их в CI
artifacts. Большие бинарные наборы и личные данные в PR не добавлены.
