"""Tokenlearn-train the jina static model on teacher features, then save fp32 + int8.

Steps: distill jina (same vocab as the plain distill, no added words: tokenlearn's
create_vocab splits on \\w+, which turns whole Chinese clauses into "words"), shuffle the
features (featurize_teacher.py writes them length-sorted), and run tokenlearn's train_model.

Usage: python train_tokenlearn.py <data_dir> [pca_dims=256]
"""

import sys
from pathlib import Path

import numpy as np
import tokenlearn.pretrain as tl_pretrain
from model2vec import StaticModel
from model2vec.distill import distill
from tokenlearn.train import train_model
from tokenlearn.utils import collect_means_and_texts

TEACHER = "jinaai/jina-embeddings-v2-base-zh"
MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
SEED = 13


class _PadIdFineTuner(tl_pretrain.StaticModelFineTuner):
    """tokenlearn looks up "[PAD]"; jina's tokenizer calls it "<pad>" (id 0, also the collate pad value).

    With pad_id=None, tokenlearn's `weights[pad_id] = 0` would zero every token weight.
    """

    def __init__(self, vectors, out_dim, pad_id):
        super().__init__(vectors, out_dim, 0 if pad_id is None else pad_id)


tl_pretrain.StaticModelFineTuner = _PadIdFineTuner


def main() -> None:
    data_dir = Path(sys.argv[1])
    pca_dims = int(sys.argv[2]) if len(sys.argv) > 2 else 256

    texts, vecs = collect_means_and_texts(sorted((data_dir / "features").glob("*.json")))
    order = np.random.default_rng(SEED).permutation(len(texts))
    texts = [texts[i] for i in order]
    vecs = vecs[order]
    print(f"{len(texts)} training texts, target dim {vecs.shape[1]}")

    base = distill(model_name=TEACHER, pca_dims=pca_dims, device="cpu", trust_remote_code=True)
    model = train_model(base, texts, vecs, device="cpu", pca_dims=pca_dims)

    fp32_dir = MODELS_DIR / f"m2v-jina-zh-{pca_dims}-tl-fp32"
    model.save_pretrained(str(fp32_dir))
    int8 = StaticModel.from_pretrained(str(fp32_dir), quantize_to="int8", force_download=False)
    int8_dir = MODELS_DIR / f"m2v-jina-zh-{pca_dims}-tl-int8"
    int8.save_pretrained(str(int8_dir))
    print(f"saved {fp32_dir.name} and {int8_dir.name}")


if __name__ == "__main__":
    main()
