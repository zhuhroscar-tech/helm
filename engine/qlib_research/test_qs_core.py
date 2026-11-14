"""Unit tests for qs_core. Run: python test_qs_core.py  (no pytest needed)."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qs_core as C  # noqa: E402


def _px(rows, cols=("A", "B")):
    idx = pd.bdate_range("2020-01-01", periods=len(rows))
    return pd.DataFrame(rows, index=idx, columns=list(cols))


def test_next_open_execution_no_same_day_leak():
    # A jumps on the close of the signal day (day 1). A strategy that picks A at the
    # day-1 signal must NOT earn that jump, because it fills at the day-2 open.
    opens = _px([[10, 10], [10, 10], [15, 10], [15, 10]])
    closes = _px([[10, 10], [15, 10], [15, 10], [15, 10]])
    sim = C.simulate(opens, closes, {opens.index[1]: pd.Series({"A": 1.0})}, cost_bps=0)
    assert abs(sim["nav"].iloc[-1] - 1.0) < 1e-12, sim
    # Signal on day 0 fills at day-1 open (10) and captures the jump to 15.
    sim2 = C.simulate(opens, closes, {opens.index[0]: pd.Series({"A": 1.0})}, cost_bps=0)
    assert abs(sim2["nav"].iloc[-1] - 1.5) < 1e-12


def test_costs_on_traded_notional_and_cash_identity():
    opens = _px([[10, 20]] * 4)
    closes = _px([[10, 20]] * 4)
    t = {opens.index[0]: pd.Series({"A": 1.0}), opens.index[1]: pd.Series({"B": 1.0})}
    sim = C.simulate(opens, closes, t, cost_bps=10)
    # Day 1: buy ~1.0 of A -> cost ~0.001. Day 2: sell ~1 and buy ~1 -> cost ~0.002.
    assert abs(sim["cost"].iloc[1] - 0.001 / 1.001) < 1e-9
    assert abs(sim["nav"].iloc[1] - (1 - sim["cost"].iloc[1])) < 1e-12
    assert 0.0019 < sim["cost"].iloc[2] < 0.0021
    assert abs(sim["nav"].iloc[-1] - (1 - sim["cost"].sum())) < 1e-12
    assert (sim["cash"] >= -1e-12).all()


def test_weight_drift_and_idle_cash():
    opens = _px([[10, 10], [10, 10], [20, 10], [20, 10]])
    closes = _px([[10, 10], [10, 10], [20, 10], [20, 10]])
    sim = C.simulate(opens, closes, {opens.index[0]: pd.Series({"A": 0.25, "B": 0.25})}, cost_bps=0)
    # Half in cash earning 0; A doubles -> NAV = 0.5 + 0.25*2 + 0.25 = 1.25
    assert abs(sim["nav"].iloc[-1] - 1.25) < 1e-12
    assert abs(sim["cash"].iloc[-1] - 0.5) < 1e-12
    assert abs(sim["exposure"].iloc[-1] - 0.75 / 1.25) < 1e-12  # drifted, not reset


def test_untradable_name_stays_in_cash():
    opens = _px([[10, np.nan], [10, np.nan], [10, 10]])
    closes = _px([[10, np.nan], [10, np.nan], [10, 10]])
    sim = C.simulate(opens, closes, {opens.index[0]: pd.Series({"A": 0.5, "B": 0.5})}, cost_bps=0)
    assert abs(sim["cash"].iloc[-1] - 0.5) < 1e-12


def test_delisted_name_liquidated_at_last_close():
    opens = _px([[10, 10], [10, 10], [12, np.nan], [12, np.nan]])
    closes = _px([[10, 10], [11, 10], [12, np.nan], [12, np.nan]])
    sim = C.simulate(opens, closes, {opens.index[0]: pd.Series({"A": 0.5, "B": 0.5})}, cost_bps=0)
    # B's data ends on day 1 at 10 -> converted to cash 0.5 on day 2, not frozen as a phantom holding.
    assert abs(sim["cash"].iloc[-1] - 0.5) < 1e-12 and sim["n_pos"].iloc[-1] == 1
    assert abs(sim["nav"].iloc[-1] - (0.5 + 0.05 * 12)) < 1e-12


def test_membership_matrix_and_history_detection():
    import qs_membership as M
    iv = pd.DataFrame({"ticker": ["A", "B", "B"], "start": pd.to_datetime(["2020-01-01", "2020-01-01", "2020-01-08"]),
                       "end": pd.to_datetime(["2020-01-10", "2020-01-03", "2020-01-10"])})
    m = M.member_matrix(iv, pd.bdate_range("2020-01-01", "2020-01-10"), ["A", "B"])
    assert m["A"].all() and m["B"].sum() == 6 and not m.loc["2020-01-06", "B"]
    snap = pd.DataFrame({"ticker": ["X", "Y"], "start": pd.to_datetime(["2000-01-01", "2012-05-01"]),
                         "end": pd.to_datetime(["2099-12-31", "2099-12-31"])})
    assert not M._has_history(snap)  # listing dates alone are not membership history
    assert M._has_history(iv)


def test_topk_dropout():
    s = pd.Series({"a": 5, "b": 4, "c": 3, "d": 2, "e": 1})
    assert C.topk_dropout(s, [], 2, 1) == ["a", "b"]
    # held d,e both outside top-2; n_drop=1 sells only the worst (e)
    assert sorted(C.topk_dropout(s, ["d", "e"], 2, 1)) == ["a", "d"]
    assert C.topk_dropout(s, ["d", "e"], 2, None) == ["a", "b"]
    # held names inside the top-k are never dropped
    assert sorted(C.topk_dropout(s, ["a", "b"], 2, 1)) == ["a", "b"]


def test_splits_purged_and_holdout_untouched():
    cal = pd.bdate_range("2008-01-01", "2024-12-31")
    for h in (5, 20, 40):
        s = C.design_splits(cal, "2008-01-01", 2, h)
        assert C.check_no_overlap(s, cal) == [], C.check_no_overlap(s, cal)
        assert all(f.test[1] < s["holdout_start"] for f in s["folds"])
        assert s["final"].valid[1] < s["holdout_start"]
        j = C.splits_to_json(s)
        assert C.splits_to_json(C.splits_from_json(j)) == j
    # A deliberately unpurged split must be flagged.
    bad = C.design_splits(cal, "2008-01-01", 2, 20)
    f0 = bad["folds"][0]
    bad["folds"][0] = C.Fold(f0.name, (f0.train[0], f0.valid[0] - pd.Timedelta(days=1)), f0.valid, f0.test)
    assert C.check_no_overlap(bad, cal)


def test_label_matches_execution():
    assert C.label_expr(20) == "Ref($open, -21)/Ref($open, -1) - 1"
    assert C.purge_days(20) == 21


def test_metrics_and_annual():
    idx = pd.bdate_range("2020-01-01", "2021-12-31")
    nav = pd.Series(np.linspace(1, 2, len(idx)), index=idx)
    p = C.perf(nav)
    assert abs(p["total_return"] - 1.0) < 1e-12 and p["max_drawdown"] == 0
    a = C.annual_returns(nav)
    assert abs((1 + a).prod() - 2.0) < 1e-12


def test_verdict_weak_signal_is_negative():
    dev = {"ic_t": 0.4, "perm_p": 0.6, "sharpe_net": 0.9, "ew_sharpe": 1.0, "random_p95_sharpe": 1.2}
    v = C.verdict(dev, None)
    assert v["verdict"] == "NO RELIABLE STRATEGY FOUND" and len(v["failed"]) == 4
    good = {"ic_t": 3, "perm_p": 0.01, "sharpe_net": 1.5, "ew_sharpe": 1.0, "random_p95_sharpe": 1.2, "momentum_sharpe": 1.1}
    hold_good = {"ic_mean": 0.02, "excess_vs_ew": 0.03, "sharpe_net": 1.4, "sharpe_ci_lo": 0.2, "random_p95_sharpe": 1.0}
    assert C.verdict(good, hold_good)["verdict"].startswith("CANDIDATE")
    assert C.verdict({**good, "momentum_sharpe": 1.6}, hold_good)["verdict"] == "NO RELIABLE STRATEGY FOUND"
    hold_bad = {"ic_mean": -0.01, "excess_vs_ew": -0.02, "sharpe_net": 0.5, "sharpe_ci_lo": -0.5, "random_p95_sharpe": 1.0}
    assert C.verdict(good, hold_bad)["verdict"].startswith("INCONCLUSIVE")


def test_ic_summary_nonoverlap():
    idx = pd.bdate_range("2020-01-01", periods=200)
    ic = pd.Series(0.05 + 0.01 * np.sin(np.arange(200)), index=idx)
    s = C.ic_summary(ic, 20)
    assert s["n_nonoverlap"] == 10 and s["mean_ic"] > 0


def test_verdict_judges_selected_model_and_missing_permutation_fails():
    good = {"ic_t": 3, "perm_p": 0.01, "sharpe_net": 1.5, "ew_sharpe": 1.0, "random_p95_sharpe": 1.2, "model": "TRA"}
    hold = {"ic_mean": 0.02, "excess_vs_ew": 0.03, "sharpe_net": 1.4, "sharpe_ci_lo": 0.2, "random_p95_sharpe": 1.0}
    v = C.verdict(good, hold)
    assert v["verdict"].startswith("CANDIDATE") and any("(TRA)" in m for m in v["passed"])
    v = C.verdict({**good, "perm_p": None}, hold)
    assert v["verdict"] == "NO RELIABLE STRATEGY FOUND"
    assert any("permutation control (TRA) not run" in m for m in v["failed"])


def test_shuffle_within_date_keeps_dates_and_test_period():
    d = pd.bdate_range("2020-01-01", periods=4)
    idx = pd.MultiIndex.from_product([d, list("ABCDE")])
    y = pd.Series(np.arange(20, dtype=float), index=idx)
    y.iloc[3] = np.nan
    s = C.shuffle_within_date(y, d[1], seed=3)
    for day in d:
        assert sorted(s.loc[day].dropna()) == sorted(y.loc[day].dropna())  # same values per date
    assert s.loc[d[2]:].equals(y.loc[d[2]:])  # after the training window: untouched
    assert np.isnan(s.iloc[3]) and s.notna().sum() == y.notna().sum()  # missing labels stay missing
    assert not s.loc[d[0]].equals(y.loc[d[0]]) or not s.loc[d[1]].equals(y.loc[d[1]])
    st = C.permutation_p(0.05, [0.0, 0.01, 0.06])
    assert abs(st["p"] - 2 / 4) < 1e-12 and st["min_attainable_p"] == 0.25
    assert C.permutation_p(0.05, [])["p"] is None


def test_overlay_exposures_use_only_past_data():
    idx = pd.bdate_range("2020-01-01", periods=300)
    rng = np.random.default_rng(0)
    r = pd.Series(rng.normal(0, 0.02, 300), index=idx)
    sig = list(idx[::20])
    cut_at = idx[150]
    r2 = r.copy()
    r2[r2.index > cut_at] = -0.2  # crash after cut_at must not change earlier exposures
    for fam, pts in C.OVERLAY_GRIDS.items():
        for prm in pts[:3]:
            a = C.overlay_exposure(fam, prm, r, r, sig)
            b = C.overlay_exposure(fam, prm, r2, r2, sig)
            assert all(a[d] == b[d] for d in sig if d <= cut_at), (fam, prm)
            assert all(0 < v <= 1 for v in a.values())
    # drawdown control cuts after a 30% fall; trend filter cuts below the moving average
    fall = pd.Series([0.0] * 50 + [-0.1] * 5 + [0.0] * 50, index=idx[:105])
    ex = C.drawdown_exposure(fall, [idx[40], idx[60]], threshold=0.2, cut=0.25)
    assert ex[idx[40]] == 1.0 and ex[idx[60]] == 0.25
    ex = C.trend_exposure(fall, [idx[60]], lookback=50, cut=0.5)
    assert ex[idx[60]] == 0.5


def test_choose_overlay_needs_gain_and_breadth():
    one_lucky = [{"params": {"x": i}, "delta_sharpe": (0.3 if i == 0 else -0.05)} for i in range(10)]
    broad = [{"params": {"x": i}, "delta_sharpe": 0.05 + 0.01 * i} for i in range(10)]
    small = [{"params": {"x": i}, "delta_sharpe": 0.02} for i in range(10)]
    ch = C.choose_overlay({"a": one_lucky, "b": broad, "c": small})
    assert ch["chosen_family"] == "b" and ch["chosen"] == {"x": 9}
    assert not ch["families"]["a"]["qualifies"] and not ch["families"]["c"]["qualifies"]
    assert C.choose_overlay({"a": one_lucky})["chosen"] is None



# ---------------------------------------------------------------- ridge baseline

def _panel(n_days=300, n_names=60, beta=0.3, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.MultiIndex.from_product([pd.bdate_range("2015-01-01", periods=n_days), [f"S{i}" for i in range(n_names)]],
                                     names=["datetime", "instrument"])
    sig = rng.normal(size=len(idx))
    X = pd.DataFrame({"sig": sig, "sig_copy": sig + rng.normal(scale=1e-6, size=len(idx)), "noise": rng.normal(size=len(idx))}, index=idx)
    y = pd.Series(beta * sig + rng.normal(size=len(idx)), index=idx)
    return X, y


def test_ridge_fit_matches_closed_form_and_shrinks():
    rng = np.random.default_rng(1)
    A = rng.normal(size=(200, 4)); y = A @ np.array([1.0, -2.0, 0.5, 0.0]) + rng.normal(scale=0.1, size=200)
    w0 = C.ridge_fit(A, y, 0.0)
    ols = np.linalg.lstsq(A, y, rcond=None)[0]
    assert np.allclose(w0, ols, atol=1e-8)
    norms = [np.linalg.norm(C.ridge_fit(A, y, a)) for a in (0.0, 0.1, 1.0, 10.0)]
    assert all(a > b for a, b in zip(norms, norms[1:])), norms  # bigger penalty -> smaller weights


def test_ridge_handles_collinear_features():
    X, y = _panel(n_days=50)
    A = X[["sig", "sig_copy"]].values
    w = C.ridge_fit(A, y.values, 1e-2)
    assert np.all(np.isfinite(w)) and abs(w[0] - w[1]) < 0.05 * abs(w.sum()), w  # weight split evenly, not +huge / -huge


def test_cs_rank_features_is_per_date_and_bounded():
    X, _ = _panel(n_days=5, n_names=10)
    X.iloc[3, 2] = np.nan
    R = C.cs_rank_features(X)
    assert R.values.min() >= -0.5 and R.values.max() <= 0.5 and R.iloc[3, 2] == 0.0
    X2 = X.copy(); X2.loc[X2.index.get_level_values(0)[-1]] = 99.0  # change only the last date
    R2 = C.cs_rank_features(X2)
    first = X.index.get_level_values(0) == X.index.get_level_values(0)[0]
    assert R[first].equals(R2[first])  # other dates unaffected: no look-across-time


def test_ridge_fold_finds_signal_and_never_reads_test_labels():
    X, y = _panel()
    d = X.index.get_level_values(0)
    days = d.unique()
    tr, va, te = d <= days[179], (d > days[189]) & (d <= days[239]), d > days[249]  # gaps act as purges
    Xr = C.cs_rank_features(X)
    r = C.ridge_fold(Xr, y, tr, va, te)
    w = r["weights"]
    assert w["sig"] + w["sig_copy"] > 5 * abs(w["noise"]), w
    ic = C.daily_ic(r["pred"], y[te])
    assert ic.mean() > 0.1, ic.mean()
    y2 = y.copy(); y2[te] = np.random.default_rng(9).normal(size=int(te.sum()))  # scramble only the test labels
    r2 = C.ridge_fold(Xr, y2, tr, va, te)
    assert r2["alpha"] == r["alpha"] and np.allclose(r2["pred"].values, r["pred"].values)


def test_ic_difference_of_identical_series_is_zero():
    ic = pd.Series(np.random.default_rng(2).normal(0.02, 0.1, 300), index=pd.bdate_range("2020-01-01", periods=300))
    out = C.ic_difference(ic, ic, 5)
    assert out["mean_ic"] == 0.0


# ---------------------------------------------------------------- hyperparameter tuning (LightGBM)

def test_lhs_configs_first_is_default_and_in_range():
    base = {"learning_rate": 0.02, "num_leaves": 8, "max_depth": 3, "min_child_samples": 50, "lambda_l1": 0.05,
            "lambda_l2": 0.05, "colsample_bytree": 0.7, "subsample": 0.7, "objective": "regression"}
    cfg = C.lhs_configs(C.TUNE_SPACE, 12, 1, base)
    assert len(cfg) == 12 and cfg[0]["num_leaves"] == 8 and "objective" not in cfg[0]
    for c in cfg[1:]:
        for k, (kind, lo, hi) in C.TUNE_SPACE.items():
            assert lo - 1e-9 <= c[k] <= hi + 1e-9, (k, c[k])
            if kind == "int":
                assert isinstance(c[k], int)
    # one point per stratum (Latin hypercube) on a linear parameter
    u = sorted((c["subsample"] - 0.5) / 0.4 for c in cfg[1:])
    assert all(i / 11 - 0.01 <= x <= (i + 1) / 11 + 0.01 for i, x in enumerate(u)), u
    assert C.lhs_configs(C.TUNE_SPACE, 12, 1, base) == cfg  # reproducible


def test_halving_folds_spread_over_time():
    names = [f"y{i}" for i in range(11)]
    assert C.halving_folds(names) == ["y0", "y5", "y10"]
    assert C.halving_folds(names[:2]) == ["y0", "y1"]


def test_promote_keeps_defaults_for_comparison():
    scores = {"c0": {"a": 0.0}, "c1": {"a": 0.3}, "c2": {"a": 0.2}, "c3": {"a": 0.1}}
    assert C.promote(scores, 2) == ["c1", "c2", "c0"]


def test_cscv_pbo_noise_vs_real_edge():
    rng = np.random.default_rng(3)
    noise = rng.normal(0.02, 0.03, size=(10, 12))  # 10 folds x 12 configs, no real difference
    p = C.cscv_pbo(noise)
    assert p["combos"] == 252 and 0.2 < p["pbo"] < 0.8, p
    real = noise.copy(); real[:, 4] += 0.05  # config 4 is better in every fold
    assert C.cscv_pbo(real)["pbo"] < 0.05
    assert C.cscv_pbo(noise[:, :3]) is None  # too few configs


def test_tune_select_rules():
    sc = {"c0": {"a": 0.02, "b": 0.02}, "c1": {"a": 0.03, "b": 0.03}, "c2": {"a": 0.021, "b": 0.02}}
    assert C.tune_select(sc, {"pbo": 0.1})["chosen"] == "c1"
    assert C.tune_select(sc, {"pbo": 0.7})["chosen"] == "c0"          # overfit -> keep defaults
    assert C.tune_select(sc, None)["chosen"] == "c0"                  # cannot check -> keep defaults
    small = {"c0": {"a": 0.02}, "c1": {"a": 0.021}}
    assert C.tune_select(small, {"pbo": 0.1})["chosen"] == "c0"       # gain below 0.002 -> keep defaults

def test_rerank_among_eligible_ignores_non_members():
    d = pd.bdate_range("2020-01-01", periods=3)
    idx = pd.MultiIndex.from_product([d, ["A", "B", "C", "FUT"]], names=["datetime", "instrument"])
    f = pd.DataFrame({"x": np.tile([1, 2, 3, 100], 3).astype("float32")}, index=idx)
    el = pd.Series([n != "FUT" for _ in d for n in ["A", "B", "C", "FUT"]], index=idx)
    a = C.rerank_among_eligible(f, el)
    f2 = f.copy()
    f2.loc[(slice(None), "FUT"), "x"] = -100.0          # a later joiner's value must not move members' ranks
    b = C.rerank_among_eligible(f2, el)
    assert a[el.values].equals(b[el.values])
    assert np.allclose(a.xs(d[0])["x"].iloc[:3], [(1 / 3 - 0.5) * 3.46, (2 / 3 - 0.5) * 3.46, 0.5 * 3.46])
    assert a.dtypes.iloc[0] == np.float32


def test_block_bootstrap_samples_the_ends_of_the_period():
    # 1 year of gains then a 15-day losing streak at the very end: circular blocks must see the streak
    r = pd.Series(np.r_[np.random.default_rng(3).normal(0.0012, 0.01, 489), np.full(15, -0.02)])
    b = C.block_bootstrap_sharpe(r)
    full = r.mean() / r.std() * np.sqrt(252)
    assert b["lo"] < full < b["hi"], b
    assert b["lo"] < 0, b      # the non-circular version gave lo = +0.28 here (passes the holdout gate)


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                fails += 1
                print(f"FAIL {name}: {e!r}")
    print(f"{'ALL PASSED' if not fails else f'{fails} FAILED'}")
    sys.exit(1 if fails else 0)
