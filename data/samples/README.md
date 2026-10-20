# OSM sample data — ODbL 1.0; Wikidata text — CC0 1.0

© OpenStreetMap contributors. Эти данные доступны по
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
[Условия и атрибуция OpenStreetMap](https://www.openstreetmap.org/copyright).
Лицензия данных не назначает лицензию исходному коду проекта.

- `astana-overpass-cache.json` — полный полученный Overpass JSON в envelope с
  временем загрузки и SHA-256. Служит воспроизводимым входом и 24-hour cache.
- `astana-osm.json` — 628 canonical Place records и встроенный manifest.
- `astana-wikidata-cache.json` — один ответ API для семи точных OSM QID, labels,
  aliases и короткие descriptions на ru/kk/en. Данные Wikidata доступны по
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/); [условия](https://www.wikidata.org/wiki/Wikidata:Licensing).
  В комбинированном snapshot сохранена ODbL атрибуция OSM и отдельные Wikidata evidence.
- `astana-official-supplement.json` — проверенные редакционные заметки об 11
  местах по 16 официальным страницам. Это короткие фактические пересказы со
  ссылками, временем чтения и областью каждого утверждения; не копии статей или
  изображений. Лицензии OSM/Wikidata не присваиваются содержимому этих сайтов.
  Дополнение воспроизводится без сети и не изменяет даты исходных OSM/Wikidata.
- `../manifests/astana-osm.json` — копия manifest, query, hash, coverage и ограничения.

SHA-256 считается по UTF-8 JSON с сортировкой ключей, без пробелов, `ensure_ascii=false`,
`allow_nan=false`, без завершающего LF. `raw_sha256` относится к объекту `payload`
raw cache, `places_sha256` — к массиву normalized `places`. Это контроль
воспроизводимости и повреждения, не цифровая подпись доверенного издателя.

Не используйте названия, категории или время загрузки как подтверждение
безопасности, доступности и фактической работы. Время загрузки источника —
2026-10-18 22:30:43 UTC; время OSM replica — 2026-10-18 22:29:47 UTC.
Это реальный импорт, не synthetic fixture. Политика выбора и инструкции
обновления описаны в `packages/city_data/README.md`.
Wikidata получена одним GET 2026-10-19 07:45:49 UTC. Это время загрузки, не
проверки фактов; source revisions и их modified_at сохранены отдельно. OSM-кэш
при расширении 300 → 628 и добавлении Wikidata не обновлялся.

Официальные страницы прочитаны 2026-10-19 и 2026-10-20; `retrieved_at` в дополнении — время
исследования опубликованных страниц через веб-индекс, не полевой проверки и не
гарантия свежести индексной копии. Политика источников, ограничения и исключённые
ошибочные страницы описаны в `docs/data/official-sources.md`.
