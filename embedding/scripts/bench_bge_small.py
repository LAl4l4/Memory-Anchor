"""Benchmark bge-small-zh-v1.5 (ONNX, via onnxruntime) on the smoke-test corpus.

Uses the same ONNX files and runtime engine that @huggingface/transformers / onnxruntime-node
would load in Node, so quality and speed here approximate the shipped setup.
"""

import os
import time

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

from smoke_test import DOCS, evaluate

REPO = "Xenova/bge-small-zh-v1.5"
# Recommended by BAAI for short-query -> passage retrieval; passages get no prefix.
QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："


class BgeOnnx:
    def __init__(self, onnx_file: str, max_length: int = 512) -> None:
        path = hf_hub_download(REPO, f"onnx/{onnx_file}")
        self.size_mb = os.path.getsize(path) / 1e6
        self.session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self.input_names = {i.name for i in self.session.get_inputs()}
        self.tokenizer = Tokenizer.from_file(hf_hub_download(REPO, "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length)
        self.tokenizer.enable_padding()

    def encode(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        out = []
        for i in range(0, len(texts), batch_size):
            enc = self.tokenizer.encode_batch(texts[i : i + batch_size])
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            feeds = {"input_ids": ids, "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64)}
            if "token_type_ids" in self.input_names:
                feeds["token_type_ids"] = np.zeros_like(ids)
            hidden = self.session.run(None, feeds)[0]
            out.append(hidden[:, 0])  # CLS pooling, as bge specifies
        return np.concatenate(out)

    def encode_query(self, texts: list[str]) -> np.ndarray:
        return self.encode([QUERY_INSTRUCTION + t for t in texts])


def throughput(name: str, encode, texts: list[str]) -> None:
    encode(texts[:32])  # warm-up
    start = time.time()
    encode(texts)
    dt = time.time() - start
    print(f"  {name}: {len(texts)} texts in {dt:.2f}s ({len(texts) / dt:,.0f} texts/s)")


def main() -> None:
    models = {f: BgeOnnx(f) for f in ("model.onnx", "model_int8.onnx")}

    for f, m in models.items():
        print(f"\n[bge-small-zh {f}] {m.size_mb:.1f} MB")
        evaluate(f"bge-small-zh {f} (no instruction)", m.encode)
        evaluate(f"bge-small-zh {f} (query instruction)", m.encode, m.encode_query)

    tok = models["model_int8.onnx"].tokenizer
    long_chunk = " ".join(DOCS * 4)
    long_tokens = len(tok.encode(long_chunk).ids)
    short_tokens = np.mean([len(tok.encode(d).ids) for d in DOCS])

    print(f"\n== throughput (onnxruntime CPU, {ort.get_device()}, default threads) ==")
    for f, m in models.items():
        throughput(f"{f} short (~{short_tokens:.0f} tok)", m.encode, [DOCS[i % len(DOCS)] for i in range(2000)])
        throughput(f"{f} chunk (~{long_tokens} tok)", m.encode, [long_chunk] * 300)


if __name__ == "__main__":
    main()
