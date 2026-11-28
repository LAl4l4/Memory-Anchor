"""Smoke test: compare the distilled static model against the jina teacher.

Prints per-query top-1 hits on a tiny zh/en corpus, plus encode throughput.
"""

import time
from pathlib import Path

import numpy as np
from model2vec import StaticModel

OUT = Path(__file__).resolve().parent.parent / "models"

DOCS = [
    "如何配置用户登录鉴权，支持 JWT token 校验",           # 0 auth
    "数据库连接池的最大连接数和超时时间设置",               # 1 db pool
    "How to deploy the service with Docker and Kubernetes",  # 2 deploy
    "缓存失效策略：LRU 淘汰与 TTL 过期",                   # 3 cache
    "Unit testing guide: mocking HTTP requests with fetch",  # 4 testing
    "日志等级说明以及如何把日志输出到文件",                 # 5 logging
    "Rate limiting API requests to prevent abuse",           # 6 rate limit
    "向量检索的召回率评估方法",                             # 7 retrieval eval
]

# (query, expected doc index)
QUERIES = [
    ("怎么做身份认证", 0),
    ("authentication with JWT", 0),
    ("连接数据库超时了怎么办", 1),
    ("database connection pool size", 1),
    ("用容器部署服务", 2),
    ("缓存过期时间", 3),
    ("how does cache eviction work", 3),
    ("写单元测试时怎么 mock 网络请求", 4),
    ("把 log 写到文件里", 5),
    ("接口限流", 6),
    ("how to measure recall of vector search", 7),
]


def normalize(x: np.ndarray) -> np.ndarray:
    return x / np.linalg.norm(x, axis=1, keepdims=True)


def evaluate(name: str, encode, encode_query=None) -> None:
    """Score top-1 hits; `encode_query` overrides query encoding (e.g. to add an instruction prefix)."""
    encode_query = encode_query or encode
    d = normalize(np.asarray(encode(DOCS), dtype=np.float32))
    q = normalize(np.asarray(encode_query([t for t, _ in QUERIES]), dtype=np.float32))
    sims = q @ d.T
    hits = 0
    print(f"\n== {name} ==")
    for (text, gold), row in zip(QUERIES, sims):
        top = int(row.argmax())
        rank = int((row > row[gold]).sum()) + 1
        hits += top == gold
        mark = "✓" if top == gold else "✗"
        print(f"  {mark} rank={rank}  {text}  ->  {DOCS[top][:30]}")
    print(f"  top-1 accuracy: {hits}/{len(QUERIES)}")


def throughput(name: str, encode, n: int = 20000) -> None:
    texts = [DOCS[i % len(DOCS)] + f" {i}" for i in range(n)]
    start = time.time()
    encode(texts)
    dt = time.time() - start
    print(f"  {name}: {n} texts in {dt:.2f}s ({n / dt:,.0f} texts/s)")


def main() -> None:
    models = {}
    for tag in ("fp32", "int8"):
        path = OUT / f"m2v-jina-zh-256-{tag}"
        if path.exists():
            models[f"static-{tag}"] = StaticModel.from_pretrained(str(path), force_download=False)

    # Official multilingual static model (bge-m3 teacher, tokenlearn-trained), at shipping-sized variants.
    potion = "minishlab/potion-multilingual-128M"
    models["potion-128M fp32 256d"] = StaticModel.from_pretrained(potion, force_download=False)
    models["potion-128M int8 256d"] = StaticModel.from_pretrained(potion, quantize_to="int8", force_download=False)
    models["potion-128M int8 128d"] = StaticModel.from_pretrained(
        potion, quantize_to="int8", dimensionality=128, force_download=False
    )

    for name, m in models.items():
        print(f"\n[{name}] vocab={m.embedding.shape[0]:,} dims={m.embedding.shape[1]} "
              f"weights={m.embedding.nbytes / 1e6:.1f} MB")
        evaluate(name, m.encode)

    from transformers import AutoModel

    teacher = AutoModel.from_pretrained("jinaai/jina-embeddings-v2-base-zh", trust_remote_code=True)
    evaluate("teacher jina-v2-base-zh", lambda xs: teacher.encode(xs))

    print("\n== throughput (CPU, single process) ==")
    for name, m in models.items():
        throughput(name, m.encode)
    throughput("teacher", lambda xs: teacher.encode(xs, batch_size=64), n=500)


if __name__ == "__main__":
    main()
