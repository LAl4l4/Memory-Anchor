"""Distill jina-embeddings-v2-base-zh into a Model2Vec static embedding model.

Outputs:
  ../models/m2v-jina-zh-256-fp32/  full-precision static model (reference only, not shipped)
  ../models/m2v-jina-zh-256-int8/  int8-quantized static model (for shipping)

Run on CPU: `python distill.py cpu` (model2vec disables MPS on torch >= 2.8).
"""

import sys
import time
from pathlib import Path

import torch
from model2vec import StaticModel
from model2vec.distill import distill

TEACHER = "jinaai/jina-embeddings-v2-base-zh"
PCA_DIMS = 256
OUT = Path(__file__).resolve().parent.parent / "models"


def pick_device() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    device = pick_device()
    print(f"teacher={TEACHER} pca_dims={PCA_DIMS} device={device}")

    start = time.time()
    model = distill(
        model_name=TEACHER,
        pca_dims=PCA_DIMS,
        device=device,
        trust_remote_code=True,
    )
    fp32_dir = OUT / f"m2v-jina-zh-{PCA_DIMS}-fp32"
    model.save_pretrained(str(fp32_dir))
    print(f"[fp32] saved to {fp32_dir} in {time.time() - start:.1f}s")

    int8_model = StaticModel.from_pretrained(str(fp32_dir), quantize_to="int8", force_download=False)
    int8_dir = OUT / f"m2v-jina-zh-{PCA_DIMS}-int8"
    int8_model.save_pretrained(str(int8_dir))
    print(f"[int8] saved to {int8_dir}")


if __name__ == "__main__":
    main()
