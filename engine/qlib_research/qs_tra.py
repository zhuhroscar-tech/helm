"""Qlib TRA (Temporal Routing Adaptor, Lin et al. KDD'21) for the quant-strategy engine.

Uses Qlib's own implementation: qlib.contrib.model.pytorch_tra.TRAModel on
qlib.contrib.data.dataset.MTSDatasetH, fed with the run's cached Alpha158 features
through a StaticDataLoader handler (same features LightGBM saw in that fold).

Leakage controls
  * rows after the fold's test end are not given to the dataset at all;
  * training/validation labels exist only for eligible (member + priced) rows;
  * MTSDatasetH(horizon=h+1): the router's loss memory at date t only uses samples
    whose label (open t+1+h) was realised by t;
  * labels realised on/after the holdout start are NaN (development runs never read
    holdout prices).
"""
from __future__ import annotations

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
import pandas as pd

MODELS = {
    # name: (num_states, transport_method, src_info)
    "tra": (3, "router", "LR_TPE"),
    "rnn": (1, "none", "LR_TPE"),  # same backbone, no routing: isolates the routing effect
}


def tra_fold(X: pd.DataFrame, label_rank: pd.Series, eligible: pd.Series, fold: dict, h: int,
             feats: list, seed: int, kind: str = "tra", seq_len: int | None = None, hidden: int = 32,
             n_epochs: int = 20, early_stop: int = 4, max_steps: int = 100, threads: int = 2,
             shuffle_seed: int | None = None):
    import torch
    torch.set_num_threads(threads)
    if os.environ.get("QS_TRA_BUDGET"):  # TEST ONLY: "epochs,steps" for fast smoke tests of the code path
        n_epochs, max_steps = map(int, os.environ["QS_TRA_BUDGET"].split(","))
    from qlib.contrib.data.dataset import MTSDatasetH
    from qlib.contrib.model.pytorch_tra import TRAModel
    from qlib.data.dataset.handler import DataHandlerLP
    from qlib.data.dataset.loader import StaticDataLoader

    # The router's loss memory is the last (seq_len - horizon) days of the sequence, so the
    # sequence must be longer than the masked horizon: 20 usable days of loss history.
    seq_len = seq_len or (h + 1 + 20)
    tr0, tr1 = map(pd.Timestamp, fold["train"])
    va0, va1 = map(pd.Timestamp, fold["valid"])
    te0, te1 = map(pd.Timestamp, fold["test"])
    d = X.index.get_level_values(0)
    rows = d <= te1
    Xf = X.loc[rows, feats]
    lab = label_rank[rows].copy()
    lab[~eligible[rows].values] = np.nan
    if shuffle_seed is not None:
        # Permutation control: same procedure, training-window labels shuffled across names
        # within each date (validation labels for early stopping stay real, as for LightGBM).
        import qs_core as C
        lab = C.shuffle_within_date(lab, tr1, shuffle_seed)
    # only instruments that are eligible somewhere in this fold
    insts = Xf.index.get_level_values(1)[eligible[rows].values].unique()
    keep = Xf.index.get_level_values(1).isin(insts)
    Xf, lab = Xf[keep], lab[keep]
    df = pd.concat({"feature": Xf, "label": lab.to_frame("LABEL0")}, axis=1).astype("float32")
    df.index.names = ["datetime", "instrument"]
    handler = DataHandlerLP(data_loader=StaticDataLoader(config=df))
    n_states, transport, src = MODELS[kind]
    ds = MTSDatasetH(handler, segments={"train": (tr0, tr1), "valid": (va0, va1), "test": (te0, te1)},
                     seq_len=seq_len, horizon=h + 1, num_states=n_states, memory_mode="sample",
                     batch_size=1024, shuffle=True)
    model = TRAModel(
        model_config={"input_size": len(feats), "hidden_size": hidden, "num_layers": 1, "rnn_arch": "GRU",
                      "use_attn": True, "dropout": 0.1},
        tra_config={"num_states": n_states, "hidden_size": 16, "tau": 1.0, "src_info": src},
        model_type="RNN", lr=1e-3, n_epochs=n_epochs, early_stop=early_stop, seed=seed,
        max_steps_per_epoch=max_steps,
        lamb=1.0 if transport != "none" else 0.0, rho=0.99, alpha=0.5,
        transport_method=transport, memory_mode="sample", pretrain=transport != "none")
    model.fit(ds)
    pred = model.predict(ds, segment="test")["score"]
    pred.index = pred.index.swaplevel() if pred.index.names[0] != "datetime" else pred.index
    pred = pred.sort_index()
    pred = pred[eligible.reindex(pred.index, fill_value=False).values]
    return pred.groupby(level=0).rank(pct=True)
