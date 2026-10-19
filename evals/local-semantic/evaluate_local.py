"""Exploratory CPU retrieval over actual source text, not a product quality benchmark."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time

import numpy as np
import onnxruntime as ort
import psutil
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser()
parser.add_argument("--snapshot", required=True, type=Path)
args = parser.parse_args()
raw = args.snapshot.read_bytes()
places = json.loads(raw)["places"]

def document(place):
    parts = [place["name"], ", ".join(place["categories"])]
    if place.get("description"):
        parts.append(place["description"])
    for fact in place["facts"]:
        key = fact["key"]
        if fact["status"] == "known" and (key.startswith(("name:", "wikidata:label:", "wikidata:aliases:", "wikidata:description:"))
                or key in {"description:ru", "description:kk", "description:en", "osm:alt_name", "osm:cuisine", "osm:addr:street", "osm:addr:housenumber", "has_wifi", "toilets"}):
            value = "; ".join(str(item) for item in fact["value"]) if isinstance(fact["value"], list) else str(fact["value"])
            parts.append(f"{key}: {value}")
    return ". ".join(parts)[:4000]

started = time.perf_counter()
options = ort.SessionOptions()
options.intra_op_num_threads = 4
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(ROOT / "model/model.onnx"), options, providers=["CPUExecutionProvider"])
tokenizer = Tokenizer.from_file(str(ROOT / "model/tokenizer.json"))
tokenizer.enable_truncation(max_length=256)
tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
startup = time.perf_counter() - started
print(json.dumps({"startup_seconds": round(startup, 3), "inputs": [item.name for item in session.get_inputs()],
                  "outputs": [item.name for item in session.get_outputs()]}), flush=True)

def encode(texts):
    values = tokenizer.encode_batch(texts)
    ids = np.array([entry.ids for entry in values], dtype=np.int64)
    mask = np.array([entry.attention_mask for entry in values], dtype=np.int64)
    inputs = {"input_ids": ids, "attention_mask": mask}
    if "token_type_ids" in {item.name for item in session.get_inputs()}:
        inputs["token_type_ids"] = np.array([entry.type_ids for entry in values], dtype=np.int64)
    hidden = session.run(None, inputs)[0]
    weighted = hidden * mask[:, :, None]
    pooled = weighted.sum(axis=1) / np.maximum(mask.sum(axis=1, keepdims=True), 1)
    return (pooled / np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)).astype(np.float32)

documents = ["passage: " + document(place) for place in places]
fingerprint = hashlib.sha256(json.dumps(documents, ensure_ascii=False).encode()).hexdigest()
cache = ROOT / ("vectors-" + fingerprint[:16] + ".npy")
index_start = time.perf_counter()
if cache.exists():
    vectors = np.load(cache, allow_pickle=False)
else:
    batches = []
    for offset in range(0, len(documents), 8):
        batches.append(encode(documents[offset:offset + 8]))
        if offset % 80 == 0:
            print(json.dumps({"indexed": min(offset + 8, len(documents)), "total": len(documents)}), flush=True)
    vectors = np.vstack(batches)
    np.save(cache, vectors, allow_pickle=False)
index_seconds = time.perf_counter() - index_start
assert vectors.shape == (len(places), 384) and np.isfinite(vectors).all()
queries = [
    ("en-study", "Somewhere to study"), ("ru-study", "Где можно позаниматься и почитать книги"),
    ("kk-food", "Дәмді ас"), ("ru-food", "Хочу пообедать"),
    ("en-art", "Look at paintings"), ("kk-library", "Кітап оқитын орын"),
    ("ru-wifi", "Кафе с вайфаем"), ("en-wifi", "Cafe with wireless internet"),
    ("ru-exact", "Ботанический сад"), ("en-name", "The Garden"),
    ("en-negation", "Not a cafe, a museum"), ("ru-anchor", "Кафе рядом с Национальным музеем"),
    ("en-no-match", "quantum teleportation"), ("ru-no-match", "Купить трактор"),
    ("kk-no-match", "Ұшақ жөндеу"), ("en-facilities", "quiet cafe with power outlets"),
]
cases, times = [], []
for case_id, query in queries:
    tick = time.perf_counter()
    query_vector = encode(["query: " + query])[0]
    scores = vectors @ query_vector
    best = np.argsort(-scores, kind="stable")[:5]
    elapsed = 1000 * (time.perf_counter() - tick)
    times.append(elapsed)
    cases.append({"id": case_id, "query": query, "elapsed_ms": round(elapsed, 1),
                  "results": [{"id": places[i]["id"], "name": places[i]["name"],
                               "categories": places[i]["categories"], "score": round(float(scores[i]), 4)} for i in best]})
report = {"kind": "exploratory-real-source-dense-search", "product_quality_benchmark": False,
          "filters_applied": False, "model": "intfloat/multilingual-e5-small",
          "model_revision": "614241f622f53c4eeff9890bdc4f31cfecc418b3", "provider": "CPUExecutionProvider",
          "corpus_sha256": hashlib.sha256(raw).hexdigest(), "documents_sha256": fingerprint,
          "places": len(places), "startup_seconds": round(startup, 3), "index_seconds": round(index_seconds, 3),
          "rss_mib": round(psutil.Process().memory_info().rss / 2**20, 1), "query_p50_ms": round(statistics.median(times), 1),
          "query_p95_ms": round(float(np.percentile(times, 95)), 1), "cases": cases}
(ROOT / "e5-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({key: value for key, value in report.items() if key != "cases"}, ensure_ascii=False, indent=2), flush=True)
for case in cases:
    print(json.dumps({"id": case["id"], "top3": case["results"][:3]}, ensure_ascii=False), flush=True)
