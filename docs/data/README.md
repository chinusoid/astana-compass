# Реальный снимок Астаны: происхождение и качество

Снимок получен одним ограниченным запросом Overpass **19 октября 2026,
03:30:43 Asia/Almaty (18 октября 22:30:43 UTC)**. OSM replica timestamp:
18 октября 22:29:47 UTC. Повторная сборка использовала сохранённый кэш без
дополнительного внешнего запроса. Эти timestamps описывают загрузку данных,
а не дату посещения или проверки каждого места.

Источник: © OpenStreetMap contributors.
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/),
[copyright/attribution](https://www.openstreetmap.org/copyright).
Условия запросов проверены по
[официальной документации Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).
Приложение использует локальный snapshot; public Overpass не обслуживает
пользовательские HTTP-запросы Astana Compass.

## Что входит

| Этап | Число |
| --- | ---: |
| Получено элементов в полном query response | 628 |
| Прошли нормализацию и географический фильтр | 628 |
| Включено в компактный snapshot | 300 |
| Не включено из-за sample limit | 328 |
| Категорий в snapshot | 13 |
| Отброшено невалидных записей в этом запуске | 0 |

Выборка распределена по category × сетке 0.05° и упорядочена по OSM ID.
Больше половины sample — кафе и рестораны, поскольку они представлены в
источнике значительно чаще остальных категорий. Это не статистически
репрезентативная выборка городских учреждений и не полный каталог.

| Категория | В snapshot |
| --- | ---: |
| cafe | 121 |
| restaurant | 69 |
| park | 35 |
| attraction | 16 |
| artwork | 13 |
| cinema | 9 |
| theatre | 9 |
| library | 8 |
| museum | 8 |
| arts_centre | 6 |
| garden | 3 |
| gallery | 2 |
| playground | 1 |

Границы реально выбранных координат: latitude 50.9562399–51.2892202,
longitude 71.2358957–71.6456947. Это покрытие нескольких частей города,
без утверждения о полноте отдельных административных районов.

## Измеренные пробелы

| Поле | Есть исходное значение | Доля от 300 |
| --- | ---: | ---: |
| name | 300 | 100% |
| opening_hours | 86 | 28.7% |
| name:ru | 68 | 22.7% |
| name:en | 51 | 17.0% |
| name:kk | 31 | 10.3% |
| wheelchair yes/no | 16 | 5.3% |
| description | 1 | 0.3% |
| fee yes/no | 1 | 0.3% |
| indoor yes/no | 0 | 0% |

`wheelchair=limited` не превращается в полную доступность. Восемь исходных
тегов indoor имеют иные значения и не считаются булевым подтверждением.
Отсутствие fee не доказывает бесплатный вход. Категория park/playground не
доказывает безопасность для детей; категория cafe/museum не заменяет
свидетельство конкретного свойства. Поэтому required indoor или некоторые
другие жёсткие условия честно могут дать пустую выдачу. Это известный пробел
источника, а не основание ослаблять условия.

Неизвестны `child_friendly`, `quiet`, `toilets` и динамический opening status
при импорте. Открытость вычисляет ContextProvider по исходным opening_hours;
unsupported/holiday schedules сохраняют unknown. Даже поддержанное расписание
не подтверждает фактическую работу или доступность на весь период посещения.

## Проверяемые артефакты

- `data/samples/astana-overpass-cache.json`: исходный ответ в cache envelope;
- `data/samples/astana-osm.json`: canonical Places и manifest;
- `data/manifests/astana-osm.json`: query, bbox, часы загрузки/replica,
  policy versions, raw/query/place SHA-256, исходный и выбранный coverage;
- `packages/city_data`: importer, repository и offline tests.

Raw SHA-256: `7e10e38b97d8e5cb546905f51a46d881aa35f1f4ccb26d2083c23a738746151c`.
Places SHA-256: `e646f8ba7bd3a9bb5c2ceb36c273cd113f73a141449ea71efec195f1e4b01213`.
Оба считаются по canonical JSON, описанному в `data/samples/README.md`.
Тест воспроизведения повторяет normalization/sample selection из raw cache
и сравнивает весь массив Places и manifest report без сетевых запросов.

Repository возвращает независимые копии, стабильную пагинацию, nearby по
distance → ID и статус источника. Прочитанные записи не меняются при случайной
модификации результатов вызывающим кодом. Factory не подставляет fixtures
при отсутствии или повреждении `ASTANA_POI_PATH`; startup завершается ошибкой
источника. Валидный устаревший snapshot разрешён со статусом stale.

Команды импорта, запуска, ограничения ресурсов и политика обновления:
`packages/city_data/README.md`. Полноценный production путь требует PostgreSQL/
pgvector, безопасного управления обновлениями и расширения источников;
текущий JSON adapter не объявляется готовой производственной базой.
