# OSM sample data — ODbL 1.0

© OpenStreetMap contributors. Эти данные доступны по
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
[Условия и атрибуция OpenStreetMap](https://www.openstreetmap.org/copyright).
Лицензия данных не назначает лицензию исходному коду проекта.

- `astana-overpass-cache.json` — полный полученный Overpass JSON в envelope с
  временем загрузки и SHA-256. Служит воспроизводимым входом и 24-hour cache.
- `astana-osm.json` — 300 canonical Place records и встроенный manifest.
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
