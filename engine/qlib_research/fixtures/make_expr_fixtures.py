"""Build the qlib parity fixtures for qs_expr (step 0 of notes/qlib-swap-plan.md).

Needs a Python that has qlib and the shared store ~/.qlib/qlib_data/us_data. Writes, next to this file:
  expr_provider/       a small Qlib-layout provider (8 tickers, 2015-01-02..2020-11-10) with edge cases
  expr_cases.json      the formulas
  expr_expected.npz    qlib's output for every formula (float32, dates x tickers, NaN where qlib has none)

The tests in test_qs_expr.py only read these files, so they run without qlib.
Re-run only when the formula list changes:  python3 fixtures/make_expr_fixtures.py
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import qs_idea as IDEA  # noqa: E402  (parse_expr: every case must be a formula Helm accepts)

SHARED = Path.home() / ".qlib" / "qlib_data" / "us_data"
OUT = HERE / "expr_provider"
START, END = "2015-01-02", "2020-11-10"
TICKERS = ["AAPL", "MSFT", "XOM", "JPM", "KO", "SNOW", "CTXS", "NVDA"]
FIELDS = ["open", "high", "low", "close", "volume"]

R = "($close/Ref($close,1)-1)"
CASES = [
    # fields and arithmetic
    "$close", f"{R}", "$vwap/$close-1", "$factor*$close", "1-$close/Max($high,252)", "Ref($close,0)", "Ref($close,5)",
    # rolling and expanding (window 0) statistics
    "Mean($close,20)", "Mean($close,0)", "Sum($volume,5)", "Sum($volume,0)", f"Std({R},60)", "Std($close,0)",
    "Var($close,10)", f"Skew({R},20)", f"Kurt({R},20)", f"Skew({R},0)", "Max($high,20)", "Min($low,0)",
    "Med($close,15)", "Med($close,0)", "Mad($close,10)", "Mad($close,0)", "Count($close,20)", "Count($close,0)",
    "Delta($close,5)", "Delta($close,0)", "Quantile($close,20,0.8)", "Quantile($close,0,0.5)",
    # regressions on time (Cython in qlib)
    "Slope($close,20)", "Slope($close,0)", "Rsquare($close,20)", "Rsquare($close,0)", "Resi($close,20)", "Resi($close,0)",
    # apply-based (window length and NaN sensitive)
    "Rank($close,20)", "Rank($close,0)", "IdxMax($close,20)", "IdxMin($close,0)", "IdxMax($close,0)",
    "WMA($close,10)", "WMA($close,0)", "EMA($close,10)", "EMA($close,0.3)", "EMA($close,0)",
    # pairs
    "Corr($close,$volume,20)", "Cov($close,$volume,20)", "Cov($close,$volume,0)", f"Cov({R},$mkt,60)/Var($mkt,60)",
    f"Corr({R},$mkt,60)",
    # element-wise
    f"Abs({R})", "Log($volume)", "Sign(Delta($close,1))", "Power($close,0.5)", f"Power(2,{R})",
    "Greater($open,$close)", "Less($open,Mean($close,5))",
    # comparisons and logic (bool dtype quirks: bool + bool is OR in numpy)
    "Gt($close,$open)", "$close>Mean($close,50)", "0<Delta($close,1)", "Mean(Gt($close,$open),20)",
    "Mean(Ge($close,Ref($close,1)),10)", "Sum(Le($close,Ref($close,1)),0)", "Eq($volume,0)", "Ne(Sign(Delta($close,1)),0)",
    "And(Gt($close,$open),Lt($volume,Mean($volume,20)))", "Or(Gt($close,$open),Gt($volume,Mean($volume,20)))",
    "Not(Gt($close,$open))", "Gt($close,$open)+Gt($volume,Mean($volume,5))", "($close>$open)&($volume>0)",
    "If(Gt($close,Mean($close,20)),1,-1)", "If($close>$open,$close,$open)", "Sum(If(Gt($close,Ref($close,1)),1,0),0)",
    # nesting
    f"Rank(Std({R},20),60)", "EMA(Slope($close,10),5)", f"Mean({R},5)/Std({R},20)",
    *IDEA.KNOWN_FACTORS.values(),
]
# Evaluated again with a later start: qlib loads data only from (start - lookback), so window-0 (expanding)
# operators, Ref(x,0), EMA and anything nested depend on the start date. qs_expr must reproduce that.
LATE_START = "2017-01-03"
LATE_CASES = ["Mean($close,0)", "Ref($close,0)", "Delta($close,0)", "EMA($close,10)", "EMA($close,0.3)", "Std($close,0)",
              "Rank($close,0)", "Slope($close,0)", "Mean($close,20)", f"Mean(Mean({R},20),0)", "Ref(Mean($close,10),5)",
              "If(Gt($close,Mean($close,0)),Ref($close,0),Max($high,30))", f"Cov({R},$mkt,60)/Var($mkt,60)",
              "WMA(EMA($close,0.5),5)", *IDEA.KNOWN_FACTORS.values()]


def read_bin(t: str, f: str) -> pd.Series | None:
    p = SHARED / "features" / t.lower() / f"{f}.day.bin"
    if not p.exists():
        return None
    raw = np.fromfile(p, dtype="<f4")
    return pd.Series(raw[1:], index=pd.RangeIndex(int(raw[0]), int(raw[0]) + len(raw) - 1))


def build_provider():
    shared_cal = pd.DatetimeIndex(pd.read_csv(SHARED / "calendars" / "day.txt", header=None)[0])
    cal = shared_cal[(shared_cal >= START) & (shared_cal <= END)]
    frames = {}
    for t in TICKERS:
        df = pd.DataFrame({f: read_bin(t, f) for f in FIELDS})
        df.index = shared_cal[df.index]
        df = df.reindex(cal)
        df = df.loc[df["close"].first_valid_index(): df["close"].last_valid_index()]
        frames[t] = df
    # edge cases: a delisting, gaps inside the data, a flat stretch (zero variance), zero volume
    frames["CTXS"] = frames["CTXS"].loc[: "2019-06-28"]
    frames["XOM"].loc["2017-03-06":"2017-03-10", ["open", "high", "low", "close"]] = np.nan
    frames["XOM"].loc["2018-05-15", "volume"] = np.nan
    frames["JPM"].loc["2016-02-01":"2016-03-04", ["open", "high", "low", "close"]] = 60.0
    frames["KO"].loc["2016-07-05":"2016-07-07", "volume"] = 0.0
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "calendars").mkdir(parents=True)
    (OUT / "instruments").mkdir()
    (OUT / "calendars" / "day.txt").write_text("\n".join(d.strftime("%Y-%m-%d") for d in cal) + "\n")
    closes = pd.DataFrame({t: df["close"] for t, df in frames.items()}).reindex(cal)
    mkt = (closes / closes.shift(1) - 1).mean(axis=1)
    lines = []
    for t, df in frames.items():
        start_i = int(cal.searchsorted(df.index[0]))
        cols = {**{f: df[f].values for f in FIELDS}, "factor": np.ones(len(df)),
                "vwap": df[["high", "low", "close"]].mean(axis=1).values, "mkt": mkt.reindex(df.index).values}
        d = OUT / "features" / t.lower()
        d.mkdir(parents=True)
        for f, v in cols.items():
            np.hstack([[start_i], v]).astype("<f4").tofile(d / f"{f}.day.bin")
        lines.append(f"{t}\t{df.index[0]:%Y-%m-%d}\t{df.index[-1]:%Y-%m-%d}")
    (OUT / "instruments" / "all.txt").write_text("\n".join(lines) + "\n")
    return cal


def main():
    for c in CASES:
        IDEA.parse_expr(c)
    assert len(set(CASES)) == len(CASES), "duplicate case"
    cal = build_provider()
    import qlib
    from qlib.constant import REG_US
    from qlib.data import D
    qlib.init(provider_uri=str(OUT), region=REG_US, kernels=1, expression_cache=None, dataset_cache=None)
    out, failed = {}, {}
    for i, c in enumerate(CASES):
        try:
            df = D.features(TICKERS, [c], start_time=START, end_time=END, freq="day")
        except Exception as e:  # qlib itself cannot evaluate it: recorded, qs_expr is free to do better
            failed[c] = f"{type(e).__name__}: {e}"[:200]
            continue
        s = df.iloc[:, 0]
        if s.index.names[0] != "datetime":
            s = s.swaplevel().sort_index()
        w = s.unstack().reindex(index=cal, columns=TICKERS)
        out[f"c{i}"] = w.to_numpy(dtype="float32")
    for i, c in enumerate(LATE_CASES):
        df = D.features(TICKERS, [c], start_time=LATE_START, end_time=END, freq="day")
        s = df.iloc[:, 0]
        if s.index.names[0] != "datetime":
            s = s.swaplevel().sort_index()
        out[f"l{i}"] = s.unstack().reindex(index=cal[cal >= LATE_START], columns=TICKERS).to_numpy(dtype="float32")
    np.savez_compressed(HERE / "expr_expected.npz", **out)
    (HERE / "expr_cases.json").write_text(json.dumps({"start": START, "end": END, "tickers": TICKERS, "cases": CASES, "qlib_failed": failed,
                                                     "late_start": LATE_START, "late_cases": LATE_CASES},
                                                     indent=1) + "\n")
    print(f"{len(CASES)} cases ({len(failed)} qlib cannot evaluate), {len(cal)} days, {len(TICKERS)} tickers")
    for c, e in failed.items():
        print("  qlib failed:", c, "->", e)


if __name__ == "__main__":
    main()
