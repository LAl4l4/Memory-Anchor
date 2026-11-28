"""Build a zh+en paragraph corpus for tokenlearn from Wikipedia parquet shards.

Downloads one zh and one en shard of wikimedia/wikipedia (no `datasets` dependency, which
conflicts with the transformers<5 pin), splits articles into paragraphs, keeps mid-length
ones, and writes a shuffled JSONL of {"text", "lang"} records.

Usage: python prepare_corpus.py <data_dir> [per_language=60000]
"""

import json
import random
import sys
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

SHARDS = {
    "zh": "20231101.zh/train-00002-of-00006.parquet",
    "en": "20231101.en/train-00028-of-00041.parquet",
}
# Paragraph length bounds in characters; Chinese packs far more meaning per character.
LENGTH_BOUNDS = {"zh": (40, 600), "en": (120, 1500)}
SEED = 13


def paragraphs(lang: str, path: str, limit: int) -> list[str]:
    lo, hi = LENGTH_BOUNDS[lang]
    out: list[str] = []
    table = pq.ParquetFile(path)
    for batch in table.iter_batches(columns=["text"], batch_size=2000):
        for article in batch.column("text").to_pylist():
            for para in article.split("\n"):
                para = para.strip()
                if lo <= len(para) <= hi:
                    out.append(para)
        if len(out) >= limit * 3:  # oversample, then pick randomly across articles
            break
    random.Random(SEED).shuffle(out)
    return out[:limit]


def main() -> None:
    data_dir = Path(sys.argv[1])
    per_lang = int(sys.argv[2]) if len(sys.argv) > 2 else 60_000
    data_dir.mkdir(parents=True, exist_ok=True)

    records = []
    for lang, shard in SHARDS.items():
        path = hf_hub_download("wikimedia/wikipedia", shard, repo_type="dataset")
        paras = paragraphs(lang, path, per_lang)
        print(f"{lang}: {len(paras)} paragraphs from {shard}")
        records += [{"text": p, "lang": lang} for p in paras]

    random.Random(SEED).shuffle(records)
    out = data_dir / "corpus.jsonl"
    with out.open("w") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(records)} records to {out}")


if __name__ == "__main__":
    main()
