# Реальный снимок Астаны: происхождение и качество

OSM получен одним ограниченным запросом Overpass **19 октября 2026,
03:30:43 Asia/Almaty (18 октября 22:30:43 UTC)**. OSM replica timestamp:
18 октября 22:29:47 UTC. Расширение 300 → 628 и новая нормализация использовали
этот же raw-кэш, без повторного запроса Overpass. Семь точных OSM Wikidata QID
получены одним GET 19 октября 2026, 07:45:49 UTC. Это времена загрузки источников,
а не дата посещения или независимой проверки каждого места.

19 октября добавлено [официальное редакционное дополнение](official-sources.md):
девять страниц пяти организаций, 37 утверждений и шесть развёрнутых RU-описаний.
OSM/Wikidata кэши и их даты не менялись. У каждой заметки своя ссылка и время чтения;
это сведения источников, а не полевая проверка удобств.

OSM: © OpenStreetMap contributors,
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/),
[copyright/attribution](https://www.openstreetmap.org/copyright).
Wikidata text: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Правила проверены по [Overpass documentation](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html),
[Wikidata data access](https://www.wikidata.org/wiki/Wikidata:Data_access),
[API etiquette](https://www.mediawiki.org/wiki/API:Etiquette) и
[Wikidata licensing](https://www.wikidata.org/wiki/Wikidata:Licensing).
Приложение использует локальный snapshot; внешние источники не обслуживают
пользовательские HTTP-запросы Astana Compass.

## Состав

| Этап | Число |
| --- | ---: |
| Получено / прошло нормализацию | 628 / 628 |
| Включено в snapshot при default limit 1000 | 628 |
| Исключено из-за лимита / невалидности | 0 / 0 |
| Категорий | 13 |
| Точных Wikidata QID / связанных мест | 7 / 7 |
| Мест с кратким Wikidata description | 6 |
| Мест с официальным редакционным дополнением | 6 |
| Официальных страниц / утверждений | 9 / 37 |
| Непустых итоговых Place.description | 9 |

Выбор ограничен именованными категориями и bbox, не всей Астаной. Если в будущем
результат превысит 1000, применяется category × grid round-robin; число исключённых
из-за лимита выводится в manifest. Сейчас весь подходящий кэш включён. Большинство
записей — кафе и рестораны; это не статистически репрезентативная выборка.

| Категория | В snapshot |
| --- | ---: |
| cafe | 346 |
| restaurant | 172 |
| park | 35 |
| attraction | 16 |
| artwork | 13 |
| cinema / theatre | 9 / 9 |
| library / museum | 8 / 8 |
| arts_centre | 6 |
| garden / gallery / playground | 3 / 2 / 1 |

Границы: latitude 50.9562399–51.2892202, longitude 71.2358957–71.6456947.
Way/relation coordinates — bounding-box centers, не проверенные входы.
Полнота отдельных административных районов не установлена.

## Аудит тегов и результат

`raw_tag_counts` manifest содержит полный аудит 628 исходных объектов.
Таблица сравнивает наличие исходного тега и результат консервативной нормализации.

| Поле OSM | Raw / прежний snapshot 300 | Новый snapshot 628 |
| --- | ---: | --- |
| internet_access | 37 / 13 | has_wifi: 29 true, 2 false, остальные unknown |
| internet_access:fee | 12 / 6 | raw строки, не обещание бесплатного Wi-Fi |
| toilets | 9 / 4 | 9 true, остальные unknown |
| toilets:wheelchair | 2 / 1 | raw строки, не доступность всего места |
| indoor_seating | 109 / 28 | raw строки, не boolean indoor |
| outdoor_seating | 117 / 30 | raw строки |
| cuisine | 172 / 52 | 172 raw строки |
| addr:street | 111 / 53 | 111 raw строк |
| addr:housenumber | 115 / 59 | 115 raw строк |
| contact:website | 40 / 23 | 40 source URLs |
| name:ru | 94 / 68 | 94 source names |
| name:kk | 43 / 31 | 43 source names |
| name:en | 75 / 51 | 75 source names |
| wikidata | 7 / 7 | 7 точных связей, brand IDs исключены |
| description | 1 / 1 | 1 OSM description без переписывания |
| opening_hours | 188 / 86 | 188 исходных строк с evidence |
| wheelchair | 54 / 18 | 32 true, 17 false; 5 limited остаются unknown |
| indoor | 12 / 8 | room/area, boolean indoor unknown у всех |
| fee | 1 / 1 | 1 free_entry=true |
| quiet / power outlets | 0 / 0 | unknown у всех |

Кроме того, сохранены 6 highchair и 4 changing_table raw тега. Они не доказывают
child_friendly. Wi-Fi определяется только по явному `wlan`; `internet_access=yes`
означает доступ неизвестного вида. Противоречивые/неподдержанные tokens не дают
true. [OSM internet_access](https://wiki.openstreetmap.org/wiki/Key:internet_access).
`toilets=yes/no` относится к наличию туалета при объекте;
[OSM toilets](https://wiki.openstreetmap.org/wiki/Key:toilets).
Отсутствие и неоднозначные значения не превращаются в false или более широкие
подтверждения. Категория park/playground не доказывает пригодность для детей.

Wikidata: 7 EN labels, 6 RU и 6 KK labels; aliases у 3 мест на RU, 1 на KK и 1 на EN.
Descriptions Wikidata после фильтра: 3 RU, 6 EN, **0 KK**. До официального дополнения
в Place.description было 7 текстов: 1 OSM и 6 Wikidata. Теперь шесть карточек имеют
развёрнутый официальный RU-пересказ, а всего непустых описаний девять. Короткие
исходные тексты сохранены отдельными фактами.
Одна субъективная RU-строка о Ботаническом саде исключена из нормализованных
данных и поиска; выбран нейтральный EN-текст. Исходный кэш сохранён без изменений.
Ограниченный словарный фильтр не является независимой проверкой фактов.
Без редакционного дополнения выбор: OSM description → OSM description:ru/kk/en → Wikidata description:ru/kk/en.
У обогащённых карточек приоритет имеет проверенный `official:description:ru`.
Поддержанные языки остаются в facts; переводов, дополнительных
amenities и заполнения одной категорией нет. `description:source` и, когда язык
известен, `description:language` отмечают выбор.

Quiet, child_friendly, power outlets и indoor неизвестны у всех мест. Required по
ним может честно дать пустой результат. Открытость вычисляет ContextProvider из
opening_hours; неподдержанные расписания остаются unknown. Поддержанное расписание
не гарантирует фактическую работу весь визит. `osm:check_date*` — строки OSM,
не наша полевая проверка; они не подменяют timestamps evidence.

## Проверяемые примеры

- `osm:way/1395465867` Estet Coffee: wlan, toilets=yes, wheelchair=yes,
  indoor_seating=yes, outdoor_seating=no, coffee_shop, 24/7. Indoor остаётся unknown.
- `osm:node/11783576043` Drinkit: toilets=yes, internet_access=yes; Wi-Fi unknown.
- `osm:node/4894937300` Национальный музей: Q18405670, description RU/EN.
- `osm:way/917478479` Астана Опера: Q21371563, description RU/EN.
- `osm:way/69232075` Жетысу: Q104866925, description только EN.
- `osm:way/1460700597` Атамекен: Q1454511, source labels; description отсутствует.

## Воспроизведение и границы доверия

- `data/samples/astana-overpass-cache.json`: неизменённый исходный OSM response;
- `data/samples/astana-wikidata-cache.json`: один Wikidata response, request/raw
  hashes, точные QID, время загрузки, revisions и modified_at;
- `data/samples/astana-official-supplement.json`: редакционные заметки, ссылки,
  области фактов и точные привязки к шести OSM ID;
- `data/samples/astana-osm.json`: canonical Places и встроенный manifest;
- `data/manifests/astana-osm.json`: тот же manifest, bbox/query/hashes,
  normalization `osm-tags-v2`, coverage и отдельная Wikidata provenance;
- `packages/city_data`: bounded CLI, repository и offline tests.

OSM raw SHA-256: `7e10e38b97d8e5cb546905f51a46d881aa35f1f4ccb26d2083c23a738746151c`.
Wikidata raw SHA-256: `770b57e20dcb680e2dec1e4f431575b4bef651fc6d48f3bd16f39957b1134985`.
Places SHA-256: `acb20fb2606c0a7f2ef24625ccccbed64318645c65715ea7c4432005fe5157c3`.
Official supplement SHA-256: `8f5646a21864f07910d0e7586238d9b3c89a3de09059aa8d410d602166370539`.
Canonical hashing описан в `data/samples/README.md`. Это контроль повреждения и
воспроизводимости, не подпись доверенного издателя. Places воспроизводятся из
двух кэшей и официального дополнения без сети, включая descriptions и per-source evidence.

Wikidata evidence имеет type `provider`, CC0 source name, точный QID и URL revision.
Repository проверяет allowlist, match с OSM QID, source times и manifest counts;
Wikidata evidence не может подтверждать amenities. Идентичность задана OSM-связью
и не проверена независимо на месте. Обновление Wikidata не освежает OSM facts.
data_status показывает источники отдельно; unique total не удваивается.

Repository читает снимок один раз и возвращает независимые копии. Factory не
подставляет fixtures при отсутствии/повреждении ASTANA_POI_PATH. Stale snapshot
разрешён с warning. Команды импорта, offline replay и ограничения — в
`packages/city_data/README.md`. PostgreSQL/pgvector остаётся production направлением;
JSON adapter не объявляется производственной базой данных.
