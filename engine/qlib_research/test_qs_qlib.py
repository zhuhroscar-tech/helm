"""Tests for the Qlib-native layer (qs_qlib.py) on a small synthetic Qlib provider.
Run: python test_qs_qlib.py  (needs qlib + lightgbm; no network)."""
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qs_core as C  # noqa: E402
import qs_pipeline as P  # noqa: E402  (provider writer)
import qs_qlib as Q  # noqa: E402

CAL = pd.bdate_range("2019-01-01", "2020-06-30")
TMP = Path(tempfile.mkdtemp(prefix="qs_qlib_test_"))


def _frames(n=8, seed=0):
    rng = np.random.default_rng(seed)
    out = {}
    for i in range(n):
        c = 50 * np.cumprod(1 + rng.normal(0.0004, 0.02, len(CAL)))
        o = c * (1 + rng.normal(0, 0.005, len(CAL)))
        df = pd.DataFrame({"open": o, "high": np.maximum(o, c), "low": np.minimum(o, c), "close": c, "volume": 1e6}, index=CAL)
        out[f"S{i}"] = df
    out["S7"] = out["S7"].loc[:"2019-09-30"]  # prices end (delisted) while possibly held
    return out


FR = _frames()
P._write_provider(FR, TMP, "test")
Q.write_fields(TMP, {"f_x": pd.DataFrame({t: np.arange(len(CAL), dtype=float) + i for i, t in enumerate(FR)}, index=CAL)})
P._qinit_uri(str(TMP), qlib=True)
OPENS = pd.DataFrame({t: f["open"] for t, f in FR.items()}).reindex(CAL)
CLOSES = pd.DataFrame({t: f["close"] for t, f in FR.items()}).reindex(CAL)
DATA_END = {t: f.index[-1] for t, f in FR.items()}


def _targets(seed=1, k=3, every=20):
    rng = np.random.default_rng(seed)
    sig = list(CAL[5:-5:every])
    sc = pd.DataFrame(rng.random((len(sig), len(FR))), index=sig, columns=list(FR)).where(CLOSES.loc[sig].notna())
    return C.build_targets(sc, sig, k, None)


def test_qlib_backtest_matches_own_simulator():
    tg = _targets()
    for bps in (0, 10):
        q = Q.run_backtest(tg, CAL[0], CAL[-1], bps, list(FR), "S0", data_end=DATA_END)
        own = C.simulate(OPENS, CLOSES, tg, bps, start=CAL[0], end=CAL[-1])
        a, b = own["nav"] / own["nav"].iloc[0], q["nav"].reindex(own.index) / q["nav"].iloc[0]
        assert (a - b).abs().max() < 0.02, (bps, float((a - b).abs().max()))
        assert abs(Q.perf(q["nav"])["cagr"] - Q.perf(own["nav"])["cagr"]) < 0.01


def test_signal_close_fill_next_open():
    """Signal on day d -> Qlib buys at the OPEN of d+1; a gap between close(d) and open(d+1) is not earned."""
    d = CAL[100]
    tg = {d: pd.Series({"S0": 1.0})}
    q = Q.run_backtest(tg, CAL[90], CAL[110], 0, list(FR), "S0", data_end=DATA_END)
    i = CAL.get_loc(d)
    exp = CLOSES["S0"].iloc[i + 1] / OPENS["S0"].iloc[i + 1]  # first day held: open(d+1) -> close(d+1)
    got = q["nav"].loc[CAL[i + 1]] / q["nav"].loc[d]
    assert abs(got - exp) < 1e-3, (got, exp)
    assert abs(q["nav"].loc[d] / q["nav"].iloc[0] - 1) < 1e-12, "earned something before the fill"


def test_holding_whose_prices_end_is_sold_at_last_price():
    tg = {CAL[100]: pd.Series({"S7": 0.5, "S1": 0.5})}
    q = Q.run_backtest(tg, CAL[95], CAL[260], 0, list(FR), "S0", data_end=DATA_END)
    end = DATA_END["S7"]
    after = q.loc[q.index > end]
    assert after["exposure"].iloc[1] < 0.75, "dead position still counted as invested"
    assert after["cash"].iloc[1] > 0.3, "proceeds not credited as cash"


def test_metrics_equal_core_definitions():
    nav = pd.Series(np.cumprod(1 + np.random.default_rng(3).normal(0.0005, 0.01, 600)), index=pd.bdate_range("2018-01-01", periods=600))
    a, b = Q.perf(nav), C.perf(nav)
    for k in ("cagr", "sharpe", "max_drawdown"):
        assert abs(a[k] - b[k]) < 1e-9, (k, a[k], b[k])
    bench = nav * np.exp(np.random.default_rng(4).normal(0, 0.002, 600).cumsum())
    e1, e2 = Q.excess(nav, bench), C.excess_stats(nav, bench)
    assert abs(e1["ann_excess_arith"] - e2["ann_excess_arith"]) < 1e-9
    assert abs(e1["information_ratio"] - e2["information_ratio"]) < 1e-9


def _panel(n_dates=60, n_names=30, seed=5):
    rng = np.random.default_rng(seed)
    idx = pd.MultiIndex.from_product([pd.bdate_range("2020-01-01", periods=n_dates), [f"T{i}" for i in range(n_names)]],
                                     names=["datetime", "instrument"])
    x = pd.Series(rng.normal(size=len(idx)), index=idx)
    y = 0.3 * x + pd.Series(rng.normal(size=len(idx)), index=idx)
    return x, y


def test_qlib_ic_equals_core():
    x, y = _panel()
    a, b = Q.qlib_ic(x, y), C.daily_ic(x, y)
    assert np.allclose(a.values, b.reindex(a.index).values)


def test_factor_screen_uses_calc_ic_definition():
    x, y = _panel()
    xr = (x.groupby(level=0).rank(pct=True) - 0.5) * 3.46  # features are CSRankNorm ranks in the pipeline
    t = P.factor_ic_table(xr.to_frame("F"), y, 1)
    assert abs(t.loc["F", "mean_ic"] - Q.qlib_ic(xr, y).mean()) < 1e-9


def test_signal_analysis_is_sigana_metrics():
    from qlib.contrib.eva.alpha import calc_ic, calc_long_short_return
    x, y = _panel()
    sa = Q.signal_analysis(x, y, y, 5)
    ic, ric = calc_ic(x, y)
    ls, _ = calc_long_short_return(x, y)
    assert abs(sa["Rank IC"] - ric.mean()) < 1e-12 and abs(sa["ICIR"] - ic.mean() / ic.std()) < 1e-12
    assert abs(sa["Long-Short Ann Return"] - ls.mean() * 252 / 5) < 1e-12


def test_sector_demean_processor_matches_core():
    x, y = _panel()
    sec = {f"T{i}": "AB"[i % 2] for i in range(30)}
    a = Q.SectorDemean(sec)(y.to_frame("LABEL5"))["LABEL5"]
    assert np.allclose(a.values, C.sector_demean(y, sec).values)


def test_lgbmodel_learns_signal_and_shuffle_removes_it():
    x, y = _panel(n_dates=260, n_names=40, seed=7)
    X = pd.concat({"F": x, "N": pd.Series(np.random.default_rng(8).normal(size=len(x)), index=x.index)}, axis=1)
    d = x.index.get_level_values(0).unique()
    seg = {"train": (d[0], d[150]), "valid": (d[160], d[200]), "test": (d[210], d[-1])}
    params = {k: v for k, v in P.LGB_PARAMS.items()}
    pr, it = Q.lgb_fit_predict(X, y, seg, params, [0])
    ic = Q.qlib_ic(pr[0], y.reindex(pr.index)).mean()
    assert ic > 0.15, ic
    ps, _ = Q.lgb_fit_predict(X, y, seg, params, [0], shuffle_seed=1)
    ic0 = Q.qlib_ic(ps[0], y.reindex(ps.index)).mean()
    assert abs(ic0) < ic / 2, (ic0, ic)


def test_fields_and_point_in_time_market_roundtrip():
    from qlib.data import D
    mask = pd.DataFrame(False, index=CAL, columns=list(FR))
    mask.loc[CAL[10]:CAL[50], "S1"] = True
    mask.loc[CAL[80]:CAL[90], "S1"] = True
    mask.loc[CAL[20]:CAL[30], "S2"] = True
    sp = Q.spells_from_mask(mask)
    assert sp == [("S1", CAL[10], CAL[50]), ("S1", CAL[80], CAL[90]), ("S2", CAL[20], CAL[30])]
    Q.write_instruments(TMP, "test_pit", sp)
    df = D.features(D.instruments("test_pit"), ["$f_x"], start_time=CAL[0], end_time=CAL[-1])
    days = df.index.get_level_values("datetime") if "datetime" in df.index.names else df.index.get_level_values(1)
    assert len(df) == 41 + 11 + 11, len(df)
    assert set(pd.DatetimeIndex(days)) <= set(mask.index[mask.any(axis=1)])
    s1 = df.xs("S1", level="instrument")["$f_x"]
    assert float(s1.loc[CAL[10]]) == 10 + 1  # value written for that day (S1 offset 1)


def test_perf_drawdown_counts_a_loss_on_the_first_day():
    nav = pd.Series([1.0, 0.8] + list(0.8 * np.cumprod([1.001] * 30)), index=pd.bdate_range("2020-01-01", periods=32))
    p = Q.perf(nav)
    assert abs(p["max_drawdown"] + 0.2) < 1e-9, p   # qlib's product mode returned 0.0 here


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print("ALL PASSED")
