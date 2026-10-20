# Фотографии мест и иллюстрации карточек

`WikimediaPlacePhotos` получает фотографию только для места с уже установленной
в каталоге связью OpenStreetMap → Wikidata. Это отдельные метаданные обложки,
а не новый факт об удобствах, расписании или состоянии организации.
Ключ API и новые переменные окружения не нужны.

## Идентификация и источники

У места должен быть `is_synthetic: false`, известный факт `osm:wikidata`
и связанное с ним несинтетическое свидетельство `source_type: osm`.
Дополнительно проверяется точная пара идентификаторов из конечного списка:

| Каноническое место | Wikidata | Место |
| --- | --- | --- |
| `osm:way/69232075` | [Q104866925](https://www.wikidata.org/wiki/Q104866925) | Жетісу саябағы |
| `osm:way/1196402246` | [Q104866948](https://www.wikidata.org/wiki/Q104866948) | Ботанический сад |
| `osm:way/1460700597` | [Q1454511](https://www.wikidata.org/wiki/Q1454511) | Атамекен |
| `osm:node/4894937300` | [Q18405670](https://www.wikidata.org/wiki/Q18405670) | Национальный музей |
| `osm:way/917478479` | [Q21371563](https://www.wikidata.org/wiki/Q21371563) | Астана Опера |
| `osm:way/549307755` | [Q42422896](https://www.wikidata.org/wiki/Q42422896) | Триумфальная арка Мәңгілік Ел |
| `osm:way/1460537088` | [Q573362](https://www.wikidata.org/wiki/Q573362) | Центральный концертный зал «Казахстан»; название записи OSM — Astana Musical |

В `https://www.wikidata.org/w/api.php` отправляется `wbgetentities` с одним QID
и `props=claims`. Из `P18` выбирается недепрецированная запись `commonsMedia`,
сначала с рангом preferred. По полученному имени файла выполняется один запрос
к `https://commons.wikimedia.org/w/api.php`: `prop=imageinfo`,
`iiprop=url|extmetadata|mime|size`, `iiurlwidth=800`.
Поиска картинок по названию организации, соседним координатам или свободному
тексту нет. Расширение списка требует подтверждённой связи в каталоге.

Метаданные проверены живым вызовом 20 октября 2026 года:

| Место | Файл Wikimedia Commons | Автор | Лицензия |
| --- | --- | --- | --- |
| Ботанический сад | [A view of Nur-Sultan's Botanical Garden.jpg](https://commons.wikimedia.org/wiki/File:A_view_of_Nur-Sultan%27s_Botanical_Garden.jpg) | Demir Berisha | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| Жетісу | [Improvisation of Charyn Canyon in Jetisy park.jpg](https://commons.wikimedia.org/wiki/File:Improvisation_of_Charyn_Canyon_in_Jetisy_park.jpg) | Ayratayrat | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| Атамекен | [Этно-мемориальный комплекс «Карта Казахстана Атамекен».JPG](https://commons.wikimedia.org/wiki/File:%D0%AD%D1%82%D0%BD%D0%BE-%D0%BC%D0%B5%D0%BC%D0%BE%D1%80%D0%B8%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9_%D0%BA%D0%BE%D0%BC%D0%BF%D0%BB%D0%B5%D0%BA%D1%81_%C2%AB%D0%9A%D0%B0%D1%80%D1%82%D0%B0_%D0%9A%D0%B0%D0%B7%D0%B0%D1%85%D1%81%D1%82%D0%B0%D0%BD%D0%B0_%D0%90%D1%82%D0%B0%D0%BC%D0%B5%D0%BA%D0%B5%D0%BD%C2%BB.JPG) | Toshishiro | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) |
| Астана Опера | [Inside Astana's New Opera House (8282915665).jpg](https://commons.wikimedia.org/wiki/File:Inside_Astana%27s_New_Opera_House_(8282915665).jpg) | Ken and Nyetta | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| Концертный зал | [Казахстан ЦКЗ 2011 02.jpg](https://commons.wikimedia.org/wiki/File:%D0%9A%D0%B0%D0%B7%D0%B0%D1%85%D1%81%D1%82%D0%B0%D0%BD_%D0%A6%D0%9A%D0%97_2011_02.jpg) | Мазур Владимир | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |

У Национального музея и арки на момент проверки `P18` не было. Для них
и остальных мест показывается подписанная **«Иллюстрация категории»**.
Это оформленная SVG-обложка, не фотография реального объекта. Фотографии могут
быть историческими или показывать интерьер; они не подтверждают нынешний вид,
открытие, входы, доступность или расписание.

## HTTP-граница и отображение

`POST /v1/place-photo` принимает канонический `PlacePhotoRequest`:

```json
{"place_id":"osm:way/1196402246","locale":"ru"}
```

Сервер получает место из собственного репозитория. Произвольные URL, QID,
координаты, имя поиска и ключи в запросе запрещены схемой. Неизвестный ID
возвращает 404 до обращения к Wikimedia. Синтетическое место, неподдерживаемая
пара ID и место без связанного свидетельства сразу получают
`{"status":"unavailable","photo":null}` без внешнего запроса.

`PlacePhotoResponse` содержит `status: available | unavailable` и `photo`.
При `available` обязательны `url`, `source_url`, `author`, `license`,
`license_url`, `alt`; при `unavailable` поле `photo` строго равно `null`.
Контракт находится в корневой `contracts.schema.json`, из него генерируются
клиентские типы и OpenAPI. Сбой необязательного источника не мешает просмотру
места и построению маршрута.

`PlacePhoto` запрашивает метаданные, когда карточка приближается к видимой области
(`IntersectionObserver`, запас 160 px). Если API наблюдения отсутствует,
запрос начинается при монтировании. При закрытии или смене места запрос
отменяется; устаревшее фото не может подменить новую карточку.
Изображение имеет `loading=lazy`, `decoding=async`, `referrerPolicy=no-referrer`.
До его загрузки и при любой ошибке остаётся подписанная иллюстрация.

Под загруженным фото всегда видны автор, кликабельная лицензия и ссылка
на страницу файла Commons. HTML из `extmetadata` очищается до обычного текста;
активные блоки отбрасываются. Без автора или допустимой лицензии фото
не показывается. Каталог и сведения 2ГИС этим источником не меняются.

## Ограничения, хранение и отказы

- Два фиксированных HTTPS API, не более одного запроса к каждому на промах кэша.
  Перенаправления не выполняются, HTTP-повторов нет.
- `JsonHTTP`: 4 секунды на отдельный запрос, не более 256 000 байт JSON.
  Общий deadline провайдера — 8 секунд, включая его очередь.
  После поиска места HTTP-handler отдельно ограничивает фотооперацию
  `min(8, REQUEST_TIMEOUT_SECONDS)` и использует общий gate приложения.
- Принимаются только JPEG, PNG и WebP. URL миниатюры должен иметь точный хост
  `thumb.wikimedia.org` или `upload.wikimedia.org`, путь
  `/wikipedia/commons/thumb/` и размер в имени не более 1280 px.
  Размеры из метаданных ограничены 1280 × 1600. Бинарное изображение сервер
  не загружает и не проксирует; миниатюру получает браузер.
- Страница источника — только `https://commons.wikimedia.org/wiki/File:…`.
  Лицензии ограничены CC BY / CC BY-SA 2.0, 2.5, 3.0, 4.0 и CC0 / Public Domain
  Mark 1.0 на точном хосте `creativecommons.org`. Credentials и fragment
  запрещены; ненужные tracking-параметры URL миниатюры удаляются.
- Кэш содержит только метаданные Commons в памяти процесса: TTL 24 часа,
  максимум 32 записи, копирование результата при выдаче. Текущий список
  допускает только семь QID. Отсутствующий `P18` также кэшируется на 24 часа.
  Нет сохранения на диск, в БД, `localStorage` или каталог.
- HTTP 200 от MediaWiki может содержать `error` или `errors`; такой ответ
  распознаётся как сбой, а не как отсутствие фото. Ошибки и таймауты дают
  короткий отрицательный кэш на 300 секунд. Для `ratelimited` / `maxlag`
  и HTTP 429 дополнительно действует общая пауза не менее 60 секунд.
- Запрос интерактивный: пользователь ожидает обложку видимой карточки.
  Согласно документации Wikimedia он может не передавать `maxlag`.
  Адаптер не делает фоновых обходов каталога и не повторяет отказ в цикле.
- API-ответы отправляются с `Cache-Control: no-store`; клиентский `fetch`
  использует `cache: no-store`, `credentials: omit` и deadline 10 секунд.
  Это относится к API-метаданным. Сам файл миниатюры может кэшироваться браузером
  по правилам Wikimedia; приложением его байты не сохраняются.
- Кэш Commons не используется для 2ГИС: ответы 2ГИС по-прежнему не сохраняются,
  не смешиваются с `Place.facts` и не передаются в LLM.

## Проверка

`tests/integration/test_place_photos.py` проверяет связи с исходным каталогом,
whitelist, атрибуцию, очистку HTML, размер, URL, HTTP/embedded API errors,
кэш и совместный запрос нескольких читателей. `test_place_photo_api.py`
проверяет канонический HTTP/OpenAPI, 404, запрет чужих поисковых параметров,
неизменность каталога, отмену по deadline, освобождение gate и отсутствие
сетевых запросов для synthetic/unknown мест.

`place-photo.test.ts` и `place-photo.test.tsx` проверяют клиентскую границу,
видимую атрибуцию, lazy lookup, отмену, смену места и иллюстрацию при отказе.
Эти тесты не требуют внешнего API. Живая проверка выше использовала только
публичные JSON-метаданные; изображения не скачивались на диск.

Официальные источники:

- [Wikibase API](https://www.mediawiki.org/wiki/Wikibase/API).
- [MediaWiki Imageinfo: URL, размеры и extmetadata](https://www.mediawiki.org/wiki/API:Imageinfo).
- [Примеры Commons API](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki).
- [Повторное использование файлов и атрибуция](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia).
- [Maxlag: интерактивные запросы и обработка отказа](https://www.mediawiki.org/wiki/Manual:Maxlag_parameter).
