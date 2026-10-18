# PostgreSQL + pgvector: следующий backend

Этот документ описывает **проектирование следующего этапа**, а не работающий production backend. Сейчас работает локальный `snapshot-bm25-ru-kk-en-1` через canonical PlaceRepository. PostgreSQL-миграции, embeddings API, vector index и reranker ещё не реализованы и не проверялись. Не устанавливается отдельная vector DB.

## Проверенные основы

Официальный pgvector описывает сочетание vector search с PostgreSQL full-text search и объединение результатов через Reciprocal Rank Fusion либо cross-encoder. Exact nearest-neighbor полезен как контроль качества; HNSW/IVFFlat меняют баланс скорости и recall. При approximate search фильтры применяются после index scan, поэтому малые выборки могут недобирать кандидатов; iterative scans с явными лимитами помогают, но не доказывают полную recall. Это причина измерять отбор внутри географических/категорийных фильтров отдельно. [pgvector: hybrid search и filtering](https://github.com/pgvector/pgvector#hybrid-search).

Для пространственного условия использовать `ST_DWithin` над geography: расстояние задаётся в метрах, spheroid включён по умолчанию; функция использует доступные индексы для предварительного bounding-box отбора. Это иной расчёт, чем сферический haversine текущего snapshot, поэтому нужно проверить граничные точки при миграции. [PostGIS ST_DWithin](https://postgis.net/docs/ST_DWithin.html).

PostgreSQL позволяет строить weighted tsvector из разных полей, преобразовывать пользовательский текст в tsquery и ранжировать совпадения. Словари/конфигурации управляют нормализацией. Наличие подходящего казахского анализатора в конкретной установке требует отдельной проверки; нельзя обещать stemming для KK автоматически. [Управление text search](https://www.postgresql.org/docs/current/textsearch-controls.html), [словари](https://www.postgresql.org/docs/current/textsearch-dictionaries.html).

## Предлагаемая интеграция

Это решения проекта, а не требования внешней документации:

1. Координатор вводит одну согласованную миграцию. Нужны canonical place ID, источник/ревизия snapshot, geography(Point,4326), исходные names/description/categories и отдельные searchable поля. Facts/evidence остаются источником проверки ограничений; текстовый индекс не превращает слова в факты.
2. FTS строится по реальным source fields. Сохраняются ru/kk/en aliases без выдуманных переводов. Имена и категории получают больший вес. RU/EN конфигурации и KK simple+проверенный словарь сравниваются на размеченных запросах; текущие lexical rules могут оставаться deterministic fallback.
3. Документ embedding создаётся отдельным offline job. Cache key: hash нормализованных индексируемых полей + provider + model + dimensions + preprocessing_version. Таблица индексных метаданных сохраняет эти значения и corpus revision. Изменение модели/размерности требует новой версии индекса и переиндексации, не смешивания векторов.
4. Provider adapter допускается только после проверки официальной документации конкретного embedding endpoint: параметры модели/размерности, лимиты batch/tokens, стоимость, условия обработки текста. Chat API key не доказывает доступ к embeddings. Ключи только backend env. Batch/timeouts/ответные размеры ограничены, векторы проверяются на размерность и конечность. Для нового запроса допустим bounded LRU cache; сырые запросы и точные координаты не должны попадать в журналы или persistent cache.
5. В каждой ветви retrieval применяются географический радиус и исключение known violated static required. Dynamic/unknown остаются для context. FTS и vector ветви возвращают ограниченное число IDs. Их rank lists объединяются `sum(1 / (k + rank))` с начальным исследуемым `k=60`; параметр проверяется на отдельной разметке, а не объявляется универсально оптимальным.
6. У HNSW фиксируются ef_search/iterative limits и план запросов; при узком radius сравниваются exact search внутри geo-subset и ANN. Повторная deterministic проверка radius и required защищает от неправильного SQL plan/adapter. Финальное score_kind=hybrid допустимо только когда обе реальные ветви завершились успешно. При отсутствии/отказе embeddings остаётся lexical с явным warning.
7. Optional reranker получает ограниченный shortlist и source text; он не создаёт координаты, факты, инструменты или новые IDs. Время/размер вывода ограничены, invalid/provider failure оставляет прежний порядок с предупреждением. До подтверждённого улучшения held-out ranking этот шаг можно не включать.

Нужные проверки: exact-vs-ANN recall на зафиксированном corpus, multilingual held-out judgments, radius boundary, filtered ANN underfill, stale index revisions, dimension mismatch, deleted source IDs, timeout и lexical fallback. Один успешный mocked vector response не подтверждает availability реального провайдера, индекс или качество. Acceptance текущего пакета не зависит от выполнения этого roadmap.
