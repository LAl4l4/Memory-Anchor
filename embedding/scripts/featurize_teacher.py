"""Encode the tokenlearn corpus with the jina teacher (replaces tokenlearn.featurize).

tokenlearn's own featurizer goes through sentence-transformers 6, which needs transformers 5,
which cannot load jina's remote code. This loads jina directly with transformers 4.x and
writes the same feature_<n>.json / feature_<n>.npy chunk format tokenlearn reads.

Targets are the teacher's sentence embeddings (attention-masked mean pooling, unnormalized).
Texts are length-sorted for cheap padding; train_tokenlearn.py shuffles before splitting.
Existing chunks are skipped, so an interrupted run resumes.

Usage: python featurize_teacher.py <data_dir> [device=mps]
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

TEACHER = "jinaai/jina-embeddings-v2-base-zh"
MAX_LENGTH = 512
BATCH_SIZE = 32
CHUNK = 4096  # records per saved feature file


def main() -> None:
    data_dir = Path(sys.argv[1])
    device = sys.argv[2] if len(sys.argv) > 2 else ("mps" if torch.backends.mps.is_available() else "cpu")
    out_dir = data_dir / "features"
    out_dir.mkdir(parents=True, exist_ok=True)

    texts = [json.loads(line)["text"] for line in (data_dir / "corpus.jsonl").open()]
    texts.sort(key=len)

    tokenizer = AutoTokenizer.from_pretrained(TEACHER)
    model = AutoModel.from_pretrained(TEACHER, trust_remote_code=True).to(device).eval()
    print(f"{len(texts)} texts, device={device}", flush=True)

    start, done = time.time(), 0
    for c, lo in enumerate(range(0, len(texts), CHUNK)):
        stem = out_dir / f"feature_{c}"
        chunk = texts[lo : lo + CHUNK]
        if stem.with_suffix(".npy").exists():
            continue
        vecs = []
        with torch.no_grad():
            for i in range(0, len(chunk), BATCH_SIZE):
                enc = tokenizer(
                    chunk[i : i + BATCH_SIZE], padding=True, truncation=True,
                    max_length=MAX_LENGTH, return_tensors="pt",
                ).to(device)
                hidden = model(**enc).last_hidden_state
                mask = enc["attention_mask"].unsqueeze(-1).to(hidden.dtype)
                vecs.append(((hidden * mask).sum(1) / mask.sum(1)).float().cpu().numpy())
        np.save(stem.with_suffix(".npy"), np.concatenate(vecs))
        json.dump(chunk, stem.with_suffix(".json").open("w"), ensure_ascii=False)
        done += len(chunk)
        rate = done / (time.time() - start)
        left = (len(texts) - lo - len(chunk)) / rate
        print(f"chunk {c}: {lo + len(chunk)}/{len(texts)}  {rate:.0f} texts/s  ~{left / 60:.0f} min left", flush=True)


if __name__ == "__main__":
    main()
