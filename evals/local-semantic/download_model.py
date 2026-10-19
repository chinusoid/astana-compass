"""Fetch official pinned E5 ONNX artifacts for a local CPU experiment."""
import hashlib
import json
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parent
REPO = "intfloat/multilingual-e5-small"
REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
PATHS = ("onnx/model.onnx", "onnx/tokenizer.json", "onnx/tokenizer_config.json", "onnx/config.json")
target = ROOT / "model"
target.mkdir(exist_ok=True)
manifest = {"repository": REPO, "revision": REVISION, "license": "MIT", "files": {}}
with httpx.Client(timeout=httpx.Timeout(120, connect=20), follow_redirects=True,
                  headers={"User-Agent": "AstanaCompass-offline-model-research/0.1"}) as client:
    listing = client.get(f"https://huggingface.co/api/models/{REPO}/tree/{REVISION}/onnx")
    listing.raise_for_status()
    metadata = {item["path"]: item for item in listing.json()}
    for path in PATHS:
        entry = metadata[path]
        destination = target / Path(path).name
        expected = entry.get("lfs", {}).get("oid")
        size = entry["size"]
        if not 0 < size <= 600_000_000:
            raise RuntimeError("Unexpected artifact size")
        if not destination.exists() or destination.stat().st_size != size:
            temporary = destination.with_suffix(destination.suffix + ".partial")
            count = 0
            with client.stream("GET", f"https://huggingface.co/{REPO}/resolve/{REVISION}/{path}") as response:
                if response.status_code != 200:
                    raise RuntimeError(f"Official artifact download returned HTTP {response.status_code}")
                with temporary.open("wb") as stream:
                    for chunk in response.iter_bytes(1024 * 1024):
                        count += len(chunk)
                        if count > size:
                            raise RuntimeError("Artifact exceeded expected size")
                        stream.write(chunk)
            if count != size:
                raise RuntimeError("Truncated model artifact")
            temporary.replace(destination)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if expected and digest != expected:
            raise RuntimeError("Artifact SHA-256 differs from upstream LFS metadata")
        manifest["files"][destination.name] = {"source_path": path, "size": size, "sha256": digest,
                                               "upstream_lfs_sha256": expected}
        print(json.dumps({"file": destination.name, "bytes": size, "sha256": digest}), flush=True)
(target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
