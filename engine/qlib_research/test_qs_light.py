"""The idea-test / export path without qlib (notes/qlib-swap-plan.md, steps 2-3).
Run: python test_qs_light.py  (no qlib, no network, no pytest needed)."""
import json
import sys
import tempfile
import types
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.modules["qlib"] = None  # any `import qlib` raises ImportError from here on

import qs_expr as X  # noqa: E402
import qs_idea as I  # noqa: E402
import qs_metrics as QM  # noqa: E402
import qs_pipeline as P  # noqa: E402

FIX = HERE / "fixtures" / "expr_provider"


def test_pipeline_imports_without_qlib():
    assert sys.modules["qlib"] is None
    assert "qs_qlib" not in sys.modules, "qs_pipeline imported qs_qlib (and so qlib) at import time"


def test_full_research_says_qlib_is_needed():
    try:
        P.Q.lgb_fit_predict
    except RuntimeError as e:
        assert "needs qlib" in str(e)
    else:
        raise AssertionError("expected a clear 'needs qlib' error")


def test_fields_wide_shape():
    d = X.BinData(FIX)
    w = X.fields_wide(d, ["AAPL", "CTXS", "SNOW", "NOPE"], ["open", "close"], start="2019-01-02")
    c = w["close"]
    assert list(c.columns) == ["AAPL", "CTXS", "SNOW"]  # no data at all -> left out, like qlib
    assert c.dtypes.eq("float32").all() and c.index.min() == pd.Timestamp("2019-01-02")
    assert c["CTXS"].last_valid_index() == pd.Timestamp("2019-06-28")  # delisted in the fixture
    assert c["SNOW"].first_valid_index() == pd.Timestamp("2020-09-16")
    raw = np.fromfile(FIX / "features" / "aapl" / "close.day.bin", dtype="<f4")
    assert c["AAPL"].iloc[-1] == raw[-1]


def test_idea_expr_wide_uses_provider():
    I.set_provider(FIX)
    w = I.expr_wide("Mean($close,20)", ["AAPL", "SNOW", "NOPE"], "2019-01-02", None)
    assert list(w.columns) == ["AAPL", "SNOW"] and w.attrs == {}
    assert w.index.name == "datetime" and w["SNOW"].notna().sum() > 30


def test_rank_ic_check_matches_vectorised_ic():
    rng = np.random.default_rng(0)
    idx = pd.bdate_range("2020-01-01", periods=60)
    cols = [f"T{i}" for i in range(30)]
    score = pd.DataFrame(rng.normal(size=(60, 30)), idx, cols)
    ret = score * 0.1 + pd.DataFrame(rng.normal(size=(60, 30)), idx, cols)
    ret.iloc[3, :28] = np.nan  # a day with too few names is dropped by both
    a = I.daily_rank_ic(score, ret)
    b = QM.rank_ic_check(score.stack(), ret.stack())
    assert np.allclose(a.values, b.reindex(a.index).values) and len(a) == len(b) == 59


def test_yahoo_cache_keeps_history_when_refresh_fails():
    """A name cached earlier but no longer served by Yahoo (delisted) keeps its cached history."""
    with tempfile.TemporaryDirectory() as tmp:
        old_cache = P.CACHE
        P.CACHE = Path(tmp)
        try:
            ydir = Path(tmp) / "yahoo"
            ydir.mkdir()
            idx = pd.bdate_range("2015-01-01", periods=300)
            df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": np.linspace(1, 2, 300), "volume": 10.0}, idx)
            df.to_csv(ydir / "GONE.csv")
            (ydir / "index.json").write_text(json.dumps({"GONE": {"start": "2015-01-01", "last": "2016-02-24",
                                                                  "downloaded": "2016-02-25"}}))

            def download(chunk, **kw):  # Yahoo serves LIVE, nothing for GONE
                live = pd.DataFrame({"Open": 5.0, "High": 5.0, "Low": 5.0, "Close": 5.0, "Volume": 1.0},
                                    pd.bdate_range("2015-01-01", periods=100))
                return pd.concat({"LIVE": live}, axis=1)
            sys.modules["yfinance"] = types.SimpleNamespace(download=download)
            out, st = P._yahoo_frames(["GONE", "LIVE", "NEVER"], "2015-01-01")
            assert st["archived"] == ["GONE"] and st["downloaded"] == 1
            assert len(st["failed"]) == 1 and st["failed"][0].startswith("NEVER")
            assert len(out["GONE"]) == 300 and out["GONE"]["close"].iloc[-1] == 2.0
        finally:
            P.CACHE = old_cache
            sys.modules.pop("yfinance", None)


def test_env_phase_needs_qlib_only_for_full_research():
    with tempfile.TemporaryDirectory() as tmp:
        class R:
            cfg = {"idea": {"idea": "x"}}
            written = {}

            def write(self, k, v):
                self.written[k] = v
        r = R()
        P.phase_env(r, types.SimpleNamespace(idea_file=None, stop_after=None))
        assert r.written["env.json"]["packages"]["qlib"] is None
        r.cfg = {}
        try:
            P.phase_env(r, types.SimpleNamespace(idea_file=None, stop_after=None))
        except RuntimeError as e:
            assert "qlib" in str(e)
        else:
            raise AssertionError("full research without qlib should fail in the env phase")
        P.phase_env(r, types.SimpleNamespace(idea_file=None, stop_after="data"))  # universe export: fine
        del tmp


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print("ALL PASSED")
