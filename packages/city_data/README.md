# Реальные POI из OpenStreetMap

`astana_city_data:create_repository` реализует canonical `PlaceRepository` через
проверяемый JSON-снимок. Это небольшой Windows/demo adapter, который держит
неизменяемые записи в памяти и возвращает копии. PostgreSQL/pgvector остаётся
производственным направлением; база данных и SQL-индекс здесь не внедрены.

Источник — © OpenStreetMap contributors, данные распространяются по
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
[Условия и атрибуция](https://www.openstreetmap.org/copyright).
Снимок содержит реальные сведения OSM, однако загрузка не подтверждает
фактические часы работы, стоимость, доступность входа или качество места.

## Импорт отдельно от API

Пакет включён в root uv workspace. Из корня репозитория:

```powershell
uv run --locked python -m astana_city_data.importer --output data/samples/astana-osm.json --cache data/samples/astana-overpass-cache.json --manifest data/manifests/astana-osm.json --limit 1000
```

Та же команда работает в POSIX shell. Доступен entry point `astana-import-osm`.
CLI не требует ключей. Путь к кэшу должен оставаться постоянным между запусками.
Импорт читает только фиксированный HTTPS endpoint Overpass; endpoint нельзя
подменить аргументом. Один POST, без повторов и redirects, HTTP timeout 45 s,
общий deadline 60 s, query `[timeout:30][maxsize:33554432]`, максимум 8 MiB
полученного JSON и 10 000 исходных объектов. Сжатый ответ отклоняется до чтения.

Область `(west,south,east,north) = (71.20,50.95,71.65,51.30)` — область исследования,
а не административная граница. Выбираются именованные cafe, restaurant, library,
theatre, cinema, arts_centre, museum, gallery, attraction, viewpoint, artwork,
park, garden и playground. Private/no-access и disused=yes исключаются.
Данные отбираются детерминированно по категориям и сетке около 5 км, затем по ID.
`--limit` — от 1 до 1000, по умолчанию 1000. Текущий кэш содержит 628 подходящих
объектов; включены все 628. Это ограниченная выборка категорий и области, не весь город.

Успешный raw-кэш используется 24 часа. После неудачи действует cooldown 60 s;
автоматических retries нет. HTTP 429/504, `remark`/`error`, неполный JSON,
отсутствующий timestamp, пустой результат и лимит размера не заменяют хороший
снимок. При timeout даже частично полученные объекты не считаются полным импортом.
Файл `.lock` предотвращает параллельный запуск с тем же кэшем. После аварийного
завершения проверьте отсутствие другого importer, прежде чем удалять stale lock.

Такая CLI соответствует модели редких ограниченных запросов, описанной в
[официальной документации Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).
Публичный Overpass не используется как runtime backend приложения. Для частого
обновления большого каталога нужны отдельная инфраструктура и согласованная
политика источников; этот импорт не запускается при каждом посещении сайта.

### Воспроизведение без сети и Wikidata

Точный снимок из двух опубликованных кэшей, без нового внешнего запроса:

```powershell
uv run --locked python -m astana_city_data.importer --offline --output data/samples/astana-osm.json --cache data/samples/astana-overpass-cache.json --manifest data/manifests/astana-osm.json --wikidata-cache data/samples/astana-wikidata-cache.json
```

`--offline` требует существующий полный OSM-кэш с правильными query/raw SHA-256,
source timestamp и временем загрузки не в будущем. Возраст кэша не мешает
воспроизведению: исходные timestamps сохраняются, свежесть не обновляется.
Повреждение кэша завершает команду ошибкой, сетевого fallback нет.

Опциональное обновление коротких текстов Wikidata — отдельная команда:

```powershell
uv run --locked python -m astana_city_data.wikidata --snapshot data/samples/astana-osm.json --cache data/samples/astana-wikidata-cache.json
```

Затем выполните команду offline-сборки выше. Wikidata CLI использует только точные
`osm:wikidata` QID из валидного снимка; `brand:wikidata`, поиск по имени и ближайшая
географическая точка не подходят. Один GET `wbgetentities`, до 50 QID, только
info/labels/aliases/descriptions для ru/kk/en, `maxlag=5`, User-Agent с контактом,
таймаут HTTP 30 s / общий 45 s, максимум 2 MiB на wire и после распаковки gzip/deflate.
Нет redirects, автоматических retries, claims и обхода чужих сайтов. Успешный кэш
используется 24 часа; между попытками минимум 60 s, более долгий Retry-After
сервера также сохраняется и соблюдается при ручном повторе. Частичный ответ, maxlag, HTTP
429 и неверные identity/revision не заменяют хороший кэш. При обновлении OSM,
добавившем новый QID, сначала соберите OSM-снимок без `--wikidata-cache`, затем
обновите Wikidata-кэш и повторите offline-сборку.

Правила: [Wikidata data access](https://www.wikidata.org/wiki/Wikidata:Data_access),
[API etiquette](https://www.mediawiki.org/wiki/API:Etiquette),
[CC0 licensing](https://www.wikidata.org/wiki/Wikidata:Licensing).
Cache Wikidata имеет отдельные hash, время загрузки и revisions. Его обновление
не обновляет дату исходных OSM-фактов. `data_status` показывает оба источника
отдельно; `total_places` считает уникальные места, а не сумму source counts.

## Подключение к API

```powershell
$env:ASTANA_MODE = 'live'
$env:ASTANA_POI_PATH = (Resolve-Path 'data/samples/astana-osm.json').Path
uv run --locked uvicorn astana_api.app:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

В live-композиции также нужны `astana_retrieval` и `astana_city_context`.
Factory принимает `config={"mode":"live","timezone":"Asia/Almaty"}`. Если путь
не задан, файл отсутствует, пуст или повреждён, factory выбрасывает `DataError`:
ошибка источника не превращается в пустые успешные рекомендации. Прямой
`SnapshotRepository(path)` оставлен для диагностики: `data_status` показывает
`not_configured`/`unavailable`. Валидный снимок старше
`ASTANA_POI_STALE_SECONDS` (по умолчанию 604800, 7 дней) возвращает `stale` и warning.
Свежесть определяется по более старому из времени загрузки и времени OSM replica.

Ни factory, ни методы repository не открывают сетевых соединений. Файл читается
один раз при создании repository, не на каждом HTTP-запросе. После успешного
обновления снимка перезапустите API. Записи публикуются атомарной заменой файла;
manifest встроен в snapshot, отдельный manifest — удобная копия для проверки.

Методы:

- `get(id)` — canonical ID `osm:node/123`, `osm:way/123` или `osm:relation/123`;
- `list_places(bbox, query, categories, cursor, limit)` — bbox W/S/E/N, substring
  поиск без учёта регистра по названию, исходным name:ru/kk/en, alt/short/official/int
  names, descriptions, Wikidata labels/aliases и категориям; OR по категориям;
  limit 1..100. Исправление опечаток относится к Retriever, не к этому методу;
- `nearby(origin,radius_meters,limit)` — haversine distance → ID, radius до
  100 км, limit 1..1000. Это поиск близости, не построение пешего пути;
- `data_status()` — реальное число записей, последний успешный импорт, статус,
  атрибуция и ограничения; `aclose()` — освобождение lifecycle без внешних ресурсов.

Cursor связан с snapshot hash, фильтрами и размером страницы. Неверный,
подменённый по контексту или устаревший cursor отклоняется `DataError`.
Это opaque navigation token, не credential; он не содержит пользовательского
запроса, а хранит только его fingerprint и последний ID.

## Что считается известным

Каждый `Place` проверяется canonical schema и invariants. Evidence ведёт на
конкретный OSM object, с source_record_id и retrieved_at. Последнее — время
получения источника, не дата полевой проверки. Оригинальные названия сохранены
без автоматических переводов. Исходное description, если оно есть, остаётся
непроверенным текстом источника и не инструкцией системе.

`wheelchair=yes/no`, `indoor=yes/no`, `fee=no/yes` дают соответственно
`wheelchair_accessible`, `indoor`, `free_entry`. Другие значения, включая
`wheelchair=limited`, остаются unknown; raw tag сохраняется отдельным фактом.
Название категории не доказывает эти свойства. `internet_access=wlan` (включая
явный token в списке) даёт `has_wifi=true`; `no` даёт false; `yes`, `wired`,
`terminal`, противоречивый `no;wlan` и отсутствие — unknown. Стоимость Wi-Fi из
этого не следует. `toilets=yes/no` даёт boolean только для наличия туалета;
`toilets:wheelchair` не доказывает доступность всего места. `indoor=room/area`,
`indoor_seating=yes`, `highchair=yes` не доказывают `indoor` или `child_friendly`.
Отсутствующие `child_friendly`, `quiet`, `has_power_outlets` и динамический
`open_at_requested_time` — unknown.
`opening_hours` сохраняется исходной строкой с evidence, пригодной для
существующего ContextProvider; import не вычисляет постоянный open_now.

Сохраняются raw `osm:cuisine`, address, seating, highchair/changing_table,
internet_access, contact:website и исходные aliases. Контактные email/телефоны,
SSID и brand QID не переносятся в публичные Place facts. `osm:check_date*`
сохранены как строки источника, а не как наша полевая проверка.

Описание — исходный OSM `description`, при отсутствии OSM `description:ru/kk/en`,
затем Wikidata `description:ru/kk/en` в этом порядке. Переводов и заполнения одной
лишь категорией нет. `description:source`/`:language` указывают выбор; язык обычного
OSM `description` не угадывается. Все localized descriptions/labels/aliases
остаются отдельными фактами с evidence. Wikidata не перезаписывает OSM name и не
создаёт amenities. Его evidence имеет type `provider`, отдельный CC0 source name
и URL точной revision. Repository принимает только объявленные Wikidata revisions
с точной OSM-связью и запрещает подкреплять ими удобства. Связь задана OSM и не
проверена независимо на месте; текст может быть неполным или субъективным.

Координата node — исходная точка. Для way/relation используется center bounding
box, явно отмеченный фактом `osm:coordinate_kind=bounding_box_center`.
Это не гарантированный вход или доступная пешеходная точка.

Идентичные повторы одного OSM type/id схлопываются и учитываются в отчёте.
Конфликтующий повтор type/id отклоняет импорт. Разные OSM ID с одинаковым именем
и координатами сохраняются отдельно: близость не доказывает тождество.
Повторная нормализация того же кэша воспроизводима побайтно. Успешный новый импорт
полностью заменяет выборку; исчезнувший ID перестаёт выдаваться, но это не
означает, что объект закрылся: он мог выйти из query или sample selection.

## Проверка

```powershell
uv run --locked pytest packages/city_data/tests --basetemp .pytest_cache/city-data
uv run --locked ruff check packages/city_data
```

Тесты используют искусственные transport fixtures, без внешней сети; они не
выдаются за реальные данные. Отдельно сохранён полученный настоящий снимок в
`data/samples/astana-osm.json`, raw response cache и отчёт в `docs/data/README.md`.
