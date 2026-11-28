"""Monolingual retrieval eval: zh->zh and en->en, one model serving both languages.

Reports top-1 / recall@3 / MRR for BM25 alone, each embedding model alone, and
BM25 + embedding fused with RRF (the planned hybrid setup).
Run with --misses to list each model's failed queries.
"""

import math
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from model2vec import StaticModel

from bench_bge_small import BgeOnnx
from eval_data import SETS

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
RRF_K = 60


# ---------- BM25 (char bigrams for CJK, lowercase words otherwise) ----------

CJK_RUN = re.compile(r"[一-鿿]+")
WORD = re.compile(r"[a-z0-9_]+")


def tokenize(text: str) -> list[str]:
    text = text.lower()
    tokens = WORD.findall(text)
    for run in CJK_RUN.findall(text):
        tokens += [run] if len(run) == 1 else [run[i : i + 2] for i in range(len(run) - 1)]
    return tokens


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.5, b: float = 0.75) -> None:
        self.docs = [Counter(tokenize(d)) for d in docs]
        self.lens = np.array([sum(c.values()) for c in self.docs], dtype=np.float32)
        self.avg = self.lens.mean()
        df = Counter(t for c in self.docs for t in c)
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
        self.k1, self.b = k1, b

    def scores(self, query: str) -> np.ndarray:
        out = np.zeros(len(self.docs), dtype=np.float32)
        for t in tokenize(query):
            if t not in self.idf:
                continue
            for i, c in enumerate(self.docs):
                tf = c.get(t, 0)
                if tf:
                    norm = self.k1 * (1 - self.b + self.b * self.lens[i] / self.avg)
                    out[i] += self.idf[t] * tf * (self.k1 + 1) / (tf + norm)
        return out


# ---------- metrics ----------

def ranks_of(score_matrix: np.ndarray, gold: list[int]) -> list[int]:
    """1-based rank of the gold doc per query (ties resolved pessimistically)."""
    return [int((row > row[g]).sum() + (row == row[g]).sum()) for row, g in zip(score_matrix, gold)]


def rank_matrix(score_matrix: np.ndarray) -> np.ndarray:
    order = np.argsort(-score_matrix, axis=1, kind="stable")
    ranks = np.empty_like(order)
    rows = np.arange(order.shape[0])[:, None]
    ranks[rows, order] = np.arange(1, order.shape[1] + 1)
    return ranks


def rrf(*score_matrices: np.ndarray) -> np.ndarray:
    return sum(1.0 / (RRF_K + rank_matrix(s)) for s in score_matrices)


def summarize(ranks: list[int]) -> tuple[float, float, float]:
    r = np.array(ranks)
    return (r == 1).mean(), (r <= 3).mean(), (1.0 / r).mean()


# ---------- models ----------

def normalize(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    return x / np.linalg.norm(x, axis=1, keepdims=True)


def load_models() -> dict:
    models = {}
    jina_static = StaticModel.from_pretrained(str(MODELS_DIR / "m2v-jina-zh-256-int8"), force_download=False)
    models["jina-distill int8 256d (15.5MB)"] = (jina_static.encode, jina_static.encode)
    tl_dir = MODELS_DIR / "m2v-jina-zh-256-tl-int8"
    if tl_dir.exists():
        jina_tl = StaticModel.from_pretrained(str(tl_dir), force_download=False)
        models["jina-tokenlearn int8 256d (15.5MB)"] = (jina_tl.encode, jina_tl.encode)

    potion = "minishlab/potion-multilingual-128M"
    p256 = StaticModel.from_pretrained(potion, quantize_to="int8", force_download=False)
    p128 = StaticModel.from_pretrained(potion, quantize_to="int8", dimensionality=128, force_download=False)
    models["potion int8 256d (128MB)"] = (p256.encode, p256.encode)
    models["potion int8 128d (64MB)"] = (p128.encode, p128.encode)

    bge = BgeOnnx("model_int8.onnx")
    models["bge-small-zh int8 (23.9MB)"] = (bge.encode, bge.encode)
    models["bge-small-zh int8 +instr"] = (bge.encode, bge.encode_query)

    if "--no-teacher" not in sys.argv:
        from transformers import AutoModel

        teacher = AutoModel.from_pretrained("jinaai/jina-embeddings-v2-base-zh", trust_remote_code=True)
        models["[ref] jina-v2-base-zh teacher"] = (teacher.encode, teacher.encode)
    return models


def main() -> None:
    show_misses = "--misses" in sys.argv
    models = load_models()

    for lang, (docs, queries) in SETS.items():
        texts = [q for q, _ in queries]
        gold = [g for _, g in queries]
        bm25 = BM25(docs)
        bm25_scores = np.stack([bm25.scores(q) for q in texts])

        print(f"\n===== {lang}: {len(queries)} queries over {len(docs)} docs =====")
        print(f"{'method':<40}{'top1':>7}{'R@3':>7}{'MRR':>7}   |  hybrid w/ BM25 (RRF){'top1':>6}{'R@3':>7}{'MRR':>7}")
        t1, r3, mrr = summarize(ranks_of(bm25_scores, gold))
        print(f"{'BM25 (char bigram / words)':<40}{t1:>7.0%}{r3:>7.0%}{mrr:>7.2f}")

        for name, (enc_doc, enc_query) in models.items():
            d = normalize(enc_doc(docs))
            q = normalize(enc_query(texts))
            emb_scores = q @ d.T
            emb_ranks = ranks_of(emb_scores, gold)
            hyb_ranks = ranks_of(rrf(bm25_scores, emb_scores), gold)
            a, b, c = summarize(emb_ranks)
            x, y, z = summarize(hyb_ranks)
            print(f"{name:<40}{a:>7.0%}{b:>7.0%}{c:>7.2f}   |  {'':<20}{x:>6.0%}{y:>7.0%}{z:>7.2f}")
            if show_misses:
                for (text, g), r in zip(queries, emb_ranks):
                    if r > 1:
                        print(f"      miss rank={r:<2} {text}  (gold: {docs[g][:24]}…)")


if __name__ == "__main__":
    main()
