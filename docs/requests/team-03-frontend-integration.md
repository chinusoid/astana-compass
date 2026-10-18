# Team 03 · запрос интеграции frontend

Исходный upstream main: `9a9747309941e7ea5ff9c338b695e2605ccbef73`.
Перед публикацией интегрирован актуальный upstream
`7258917c3a5a81717639ee3d8abf2588d253f131`; финальные проверки выполнены на нём.
Области записи PR: `apps/web/**`, `tests/e2e/**`, `docs/ux/**`, `docs/pitch/**`,
этот запрос. Корневые manifests, lock, API, contracts, api_client не изменяются.

## Зависимости и запуск

Просьба координатору принять `apps/web` как отдельный Node-модуль либо включить
его в будущий общий pnpm workspace без изменения публичных DTO. Точные версии
есть в `apps/web/package.json` и локальном `pnpm-lock.yaml`:

- Next 16.4.2, React/React DOM 19.3.1, TypeScript 5.9.3;
- Tailwind/@tailwindcss/postcss 4.3.3, MapLibre GL JS 6.15.0;
- `@astana/api-client` через `file:../../packages/api_client`;
- Ajv 8.20.0 + ajv-formats 3.0.1 для прямой канонической JSON Schema;
- Vitest 5.0.5, Playwright 1.64.1, axe 4.14.0, React Testing Library;
- ESLint 9.39.5 + eslint-config-next 16.4.2: это совместимая версия для peer ranges
  текущих Next plugins; ESLint 10 пока несовместим с ними. Dev-tool deprecation
  требует повторной оценки при общей интеграции, production runtime её не использует.
- pnpm 11.25.0; Node >=22.12. Локальная проверка: Node 26.8.2.
- Prettier 3.9.10 — только форматирование исходников, без production-зависимости.

Потребитель: только `apps/web` и `tests/e2e`. Root Python dependencies и uv.lock не
затронуты. JS shared SDK сейчас экспортирует только generated types; транспорт
приватный в `apps/web/src/lib/api.ts`, не второй public SDK. При появлении общего
транспорта заменить этот adapter с сохранением canonical validation и abort.

Предлагаемые CI-команды, выполняемые из `apps/web`:
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build`, затем с fixture API `pnpm test:e2e`.
Изменения `.github/**` в этом PR отсутствуют; подключить эти команды — действие
координатора. Скриншоты/HTML report публиковать как CI artifacts, не бинарный набор
в main. Сборка копирует два MapLibre worker-файла из pinned dependency в `public/`.

## Live-интеграция

Ожидаются уже согласованные factories `astana_city_data:create_repository`,
`astana_retrieval:create_retriever`, `astana_city_context:create_context` и их
конфигурация. Frontend не реализует эти модули и не подменяет live fixtures.
См. фактическую проверку в `docs/ux/TEAM-03-VERIFICATION.md`.

## Необязательное последующее расширение статуса генерации

Текущий response содержит только `warnings: string[]`. Поэтому дружелюбная подпись
fallback распознаёт известные строки foundation и всегда сохраняет оригинал.
Предлагается отдельным согласованным PR добавить **optional** поле к обоим
response definitions:

```json
{
  "explanation_status": {
    "type": "object",
    "additionalProperties": false,
    "required": ["mode", "reason"],
    "properties": {
      "mode": {"enum": ["generated", "deterministic"]},
      "reason": {"enum": ["configured", "disabled", "unavailable", "refused", "invalid_output"]}
    }
  }
}
```

Причина: локализованный fallback без распознавания текста. Потребители:
recommender, API, generated SDK, frontend. Совместимость: поле необязательное;
сначала обновить canonical schema/examples/SDK, затем backend, затем UI. Проверка:
positive/negative fixtures, отказ модели, malformed/refusal, старый ответ без поля.
Это предложение, **не принятый контракт**; код текущего PR такого поля не отправляет
и не требует. Weather и intent parsing остаются отдельными задачами координатора.
