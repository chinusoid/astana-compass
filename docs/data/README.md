# Реальный снимок Астаны: происхождение и качество

OSM обновлён одним ограниченным запросом Overpass **20 октября 2026,
14:46:57 UTC**. OSM replica timestamp: 20 октября 14:44:50 UTC.
В запрос добавлен `shop=mall`: сохранены все прежние 628 OSM ID и добавлены
54 записи торговых центров, итого 682. Девять точных OSM Wikidata QID
получены одним GET 20 октября 2026, 14:48:09 UTC. Это времена загрузки источников,
а не дата посещения или независимой проверки каждого места.

19 октября добавлено [официальное редакционное дополнение](official-sources.md):
девять страниц пяти организаций, 37 утверждений и шесть развёрнутых RU-описаний.
20 октября расширено до 16 страниц семи организаций, 80 утверждений и 11
развёрнутых описаний, добавлены проверенные контакты и отдельно часы касс.
При этом редакционном расширении OSM/Wikidata кэши и их даты не менялись;
последующий импорт торговых центров обновил оба кэша 20 октября. У каждой заметки своя ссылка и время чтения;
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
| Получено / прошло нормализацию | 682 / 682 |
| Включено в snapshot при default limit 1000 | 682 |
| Исключено из-за лимита / невалидности | 0 / 0 |
| Категорий | 14 |
| Точных Wikidata QID / связанных мест | 9 / 9 |
| Мест с кратким Wikidata description | 8 |
| Мест с официальным редакционным дополнением | 11 |
| Официальных страниц / утверждений | 16 / 80 |
| Непустых итоговых Place.description | 15 |

Выбор ограничен именованными категориями и bbox, не всей Астаной. Если в будущем
результат превысит 1000, применяется category × grid round-robin; число исключённых
из-за лимита выводится в manifest. Сейчас весь подходящий кэш включён. Большинство
записей — кафе и рестораны; это не статистически репрезентативная выборка.

| Категория | В snapshot |
| --- | ---: |
| cafe | 346 |
| restaurant | 172 |
| mall | 54 |
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

`raw_tag_counts` текущего manifest содержит полный аудит 682 исходных объектов.
Следующая историческая таблица относится к прежнему снимку из 628 объектов
и сравнению с первоначальной выборкой 300. Текущие точные счётчики находятся в manifest.

| Поле OSM | Raw / первоначальный snapshot 300 | Исторический snapshot 628 |
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

Wikidata: 9 EN labels, 8 RU и 8 KK labels; aliases у 3 мест на RU, 1 на KK и 1 на EN.
Descriptions Wikidata после фильтра: 5 RU, 8 EN, **0 KK**. Теперь 11 карточек имеют
развёрнутый официальный RU-пересказ, а всего непустых описаний 15. Короткие
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
- `osm:way/69232075` Жетысу: Q104866925, развёрнутое официальное RU-описание; прежний EN source сохранён.
- `osm:way/1460700597` Атамекен: Q1454511, source labels и официальное RU-описание формата экспозиции по статье 2023 года.

Торговые центры подтверждены явным [OSM `shop=mall`](https://wiki.openstreetmap.org/wiki/Tag:shop%3Dmall).
[MEGA Silk Way](https://www.openstreetmap.org/way/499328514) и
[Abu Dhabi Plaza](https://www.openstreetmap.org/way/762780007) включены по исходным OSM ID и координатам.
`building=retail` без `shop=mall`, похожее название кафе и близость к нему
не создают категорию торгового центра. Результаты не подтверждают красоту,
наличие конкретного магазина или актуальную доступность входа.

## Воспроизведение и границы доверия

- `data/samples/astana-overpass-cache.json`: неизменённый исходный OSM response;
- `data/samples/astana-wikidata-cache.json`: один Wikidata response, request/raw
  hashes, точные QID, время загрузки, revisions и modified_at;
- `data/samples/astana-official-supplement.json`: редакционные заметки, ссылки,
  области фактов и точные привязки к 11 OSM ID;
- `data/samples/astana-osm.json`: canonical Places и встроенный manifest;
- `data/manifests/astana-osm.json`: тот же manifest, bbox/query/hashes,
  normalization `osm-tags-v3`, coverage и отдельная Wikidata provenance;
- `packages/city_data`: bounded CLI, repository и offline tests.

OSM raw SHA-256: `d09f80c4e6bf71158a38b5e6f78056f53a88d6a7716bd3ca12f49fde1170fdda`.
Wikidata raw SHA-256: `46b9848feaabab6056771abe36beee6cf5c294fb6122895973b76c6cac0cf40f`.
Places SHA-256: `16028ec831398055df990f05e8d9268e7947dad23d21d75645148e45028f0d78`.
Official supplement SHA-256: `5dc8445df95879a7a3811079f654e3d7d96684cbfd1b1b1d178d3f92cc8824d4`.
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
