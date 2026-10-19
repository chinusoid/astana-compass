# Локальный CPU-эксперимент E5

19 октября 2026 модель действительно загружена и запущена на Windows, Intel
Core i5-12500H, 12 физических / 16 логических ядер. Это отдельное исследование:
приложение продолжает использовать проверяемый lexical retrieval. Зависимости
эксперимента изолированы от основного `uv.lock`; веса не включены в Git/ZIP.

Использованы официальный `intfloat/multilingual-e5-small`, MIT, revision
`614241f622f53c4eeff9890bdc4f31cfecc418b3`, FP32 ONNX 470 268 510 байт.
SHA-256 весов и tokenizer: [model-artifacts.json](model-artifacts.json).
Загрузка ограничена ожидаемым размером и проверяет upstream LFS SHA-256.
Модель не исполняет загруженный Python-код.

Режим: ONNX Runtime 1.31.0, CPUExecutionProvider, 4 intra-op / 1 inter-op threads,
batch 8, truncation 256 tokens. Входы `query:` / `passage:`, attention-mask mean
pooling, L2 normalization, exact dot product по 628 source documents. Основой
служат исходные названия, описания, categories и выбранные known facts; служебные
provenance строки не становятся описанием. Сырые тексты запросов здесь авторские
публичные примеры, а не собранные пользовательские данные.

Snapshot SHA-256:
`bc919999881d216cf7692d2c7e3b0289fc388ce227c94a8fd00f0966bd2030df`.
Холодный проход по этому snapshot: startup 2,931 с, индексирование 24,898 с,
RSS после вычислений 833,4 МиБ, query p50/p95 17,9/23,3 мс. Это одиночный
измеренный проход при других работающих проверках; **RSS не является peak RAM**.
[results.json](results.json) сохраняет следующий проход с повторным использованием
векторов и все top 5 для 16 запросов. Время чтения готового vector cache нельзя
выдавать за время построения индекса.

Dense-only поиск дал полезные совпадения для части общих пожеланий, но запросы
«Купить трактор», «Ұшақ жөндеу» и `quantum teleportation` всё равно возвращали
городские POI с высоким score. «Not a cafe, a museum» также не соблюдал отрицание.
Казахское пожелание читать книги находило рестораны. В этих 16 примерах нет
независимой разметки, поэтому Recall/MRR продуктового качества не вычисляются.
Radius, required filters и reranking намеренно не реализованы в этом исследовании;
результаты не оценивают готовый hybrid retrieval. Они показывают, почему нельзя
заменить честный no-match на безусловный ближайший вектор.

Следующий обоснованный эксперимент — hybrid с теми же проверками radius/facts,
отдельным размеченным отложенным набором RU/KK/EN и проверкой abstention. Только
после этого можно решать вопрос включения в продукт. Semantic similarity не
восстанавливает неизвестные Wi-Fi, розетки, расписание или доступность.

## Воспроизведение

Из корня репозитория, Python 3.12; около 0,5 ГБ загрузки модели:

```powershell
uv venv .venv-e5 --python 3.12
uv pip install --python .venv-e5/Scripts/python.exe -r evals/local-semantic/requirements.lock.txt
.venv-e5/Scripts/python.exe -X utf8 evals/local-semantic/download_model.py
.venv-e5/Scripts/python.exe -X utf8 evals/local-semantic/evaluate_local.py --snapshot data/samples/astana-osm.json
```

На Linux замените `Scripts/python.exe` на `bin/python`. Только загрузчик
обращается к официальному Hugging Face; evaluator после загрузки работает локально.
`model/`, `vectors-*.npy` и локальный `e5-report.json` игнорируются Git. Для нового
snapshot не используйте прежние результаты: fingerprint source documents выбирает
отдельный cache. Отчёт содержит hash корпуса; не сравнивайте разные snapshots как
один benchmark.

Первичные источники: [model card](https://huggingface.co/intfloat/multilingual-e5-small/raw/main/README.md),
[официальные ONNX artifacts](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx),
[ONNX Runtime](https://onnxruntime.ai/docs/install/).
