"""Unit tests for qs_idea (idea test mode). Run: python test_qs_idea.py  (no Qlib, no pytest needed)."""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qs_idea as I  # noqa: E402

FUND = {k: "" for k in ("F_EP", "F_BM", "F_SP", "F_CFP", "F_SIZE", "F_ROE", "F_ROA", "F_GPA", "F_OPA", "F_ACC",
                        "F_LEV", "F_REVG", "F_NIG", "F_AG", "F_SUE")}


def _raises(fn, *a, contains=None):
    try:
        fn(*a)
    except I.IdeaError as e:
        msg = str(e)
        assert any("一" <= ch <= "鿿" for ch in msg), f"error not in Chinese: {msg}"
        if contains:
            assert contains in msg, (contains, msg)
        return msg
    raise AssertionError(f"expected IdeaError for {a}")


# ---------------------------------------------------------------- whitelist

def test_whitelist_rejects_injection():
    for bad in ["__import__(os)", "$close.__class__", "open", "eval", "eval($close)", "lambda", "lambda: 1",
                "__import__('os').system('ls')", "$close[0]", "{}", "$close; 1", "$close\\n", "exec($close)",
                "getattr($close, 1)", "Ref($close, 5).x", "$foo", "$$close", "os", "Operators", "Feature",
                "\"a\"", "$close if 1 else 2", "Ref($close,-5)", "Mean($close, -20)", "Mask($close, 1)",
                "Ref($close)", "Ref($close, $open)", "1+2", "", "   ", "Ref($close,5)(1)", "$close >> 2",
                "$close ** 2", "$close % 2", "x" * 400]:
        _raises(I.parse_expr, bad)


def test_whitelist_accepts_valid():
    for good in ["Ref($close,21)/Ref($close,252)-1", "$close/Ref($close,1)-1", "-Std($close/Ref($close,1)-1, 60)",
                 "Corr($close, Log($volume+1), 20)", "If($close > Mean($close, 50), 1, 0)", "Mean($vwap,5)/$close",
                 "Quantile($close, 20, 0.8)", "EMA($close, 0.5)", "($high-$low)/$open", "Greater($close, $open) - 1e-3",
                 "$close >= Ref($close, 1)", "($close > 1) & ($open > 1)", "Rank($close, 20)"]:
        I.parse_expr(good)


def test_lookahead_rejected():
    msg = _raises(I.parse_expr, "Ref($close,-1)")
    assert "未来" in msg


# ---------------------------------------------------------------- validation

def _idea(factors, **kw):
    return {"idea": "测试", "factors": factors, **kw}


def test_validate_limits_and_names():
    f = lambda n: {"name": n, "components": [{"expr": "$close/Ref($close,20)-1"}]}  # noqa: E731
    spec = I.validate_idea(_idea([f("a1"), {"name": "v", "label": "价值", "components": [{"fundamental": "f_ep", "weight": -1}]}]), FUND)
    assert spec["horizons"] == [5, 20, 60] and spec["factors"][1]["components"][0] == {"fundamental": "F_EP", "weight": -1.0}
    _raises(I.validate_idea, _idea([f(f"a{i}") for i in range(6)]), FUND, contains="最多")
    _raises(I.validate_idea, _idea([{"name": "x", "components": [{"expr": "$close"}] * 5}]), FUND, contains="最多")
    _raises(I.validate_idea, _idea([f("a"), f("A")]), FUND, contains="重复")
    _raises(I.validate_idea, _idea([f("1bad")]), FUND)
    _raises(I.validate_idea, _idea([{"name": "x", "components": [{"expr": "$close", "fundamental": "F_EP"}]}]), FUND)
    _raises(I.validate_idea, _idea([{"name": "x", "components": [{"expr": "$close", "weight": 0}]}]), FUND)
    _raises(I.validate_idea, _idea([f("a")], horizons=[0]), FUND)
    _raises(I.validate_idea, _idea([f("a")], horizons=[5, 10, 20, 40, 60]), FUND)
    _raises(I.validate_idea, _idea([f("a")], extra=1), FUND)
    _raises(I.validate_idea, {"factors": [f("a")]}, FUND)
    msg = _raises(I.validate_idea, _idea([{"name": "x", "components": [{"fundamental": "earnings_yield"}]}]), FUND)
    assert "F_EP" in msg and "F_SUE" in msg  # lists the valid names
    _raises(I.validate_idea, _idea([{"name": "x", "components": [{"expr": "__import__(os)"}]}]), FUND, contains="因子 x")


def test_factor_hash_order_and_scale_free():
    a = [{"expr": "Ref($close,21)/Ref($close,252)-1", "weight": 1.0}, {"fundamental": "F_EP", "weight": 1.0}]
    b = [{"fundamental": "F_EP", "weight": 2.0}, {"expr": "Ref($close, 21) / Ref($close, 252) - 1", "weight": 2.0}]
    c = [{"fundamental": "F_EP", "weight": -1.0}, {"expr": "Ref($close,21)/Ref($close,252)-1", "weight": 1.0}]
    assert I.factor_hash(a) == I.factor_hash(b) != I.factor_hash(c)


# ---------------------------------------------------------------- ranking

def test_component_ranking_combines_correctly():
    idx = pd.DatetimeIndex(["2020-01-02"])
    A = pd.DataFrame([[1, 2, 3, 4]], index=idx, columns=list("abcd"), dtype=float)
    B = pd.DataFrame([[4, 3, 2, 1]], index=idx, columns=list("abcd"), dtype=float)
    out = I.combine_components([(A, 2), (B, 1)])  # 2*[.25,.5,.75,1] + [1,.75,.5,.25] -> increasing
    assert np.allclose(out.iloc[0].values, [0.25, 0.5, 0.75, 1.0])
    out = I.combine_components([(A, -1)])  # negative weight: lower is better
    assert np.allclose(out.iloc[0].values, [1.0, 0.75, 0.5, 0.25])
    out = I.combine_components([(A, 1), (B, 3)])  # B dominates
    assert list(out.iloc[0].sort_values().index) == ["d", "c", "b", "a"]
    B2 = B.copy()
    B2.loc[idx[0], "b"] = np.nan  # a name needs every component
    out = I.combine_components([(A, 1), (B2, 1)])
    assert np.isnan(out.loc[idx[0], "b"]) and out.iloc[0].notna().sum() == 3
    el = pd.DataFrame([[True, True, False, True]], index=idx, columns=list("abcd"))
    out = I.combine_components([(A, 1)], el)  # ineligible names drop out and do not affect the ranks
    assert np.isnan(out.loc[idx[0], "c"]) and np.allclose(out.loc[idx[0], ["a", "b", "d"]].values, [1 / 3, 2 / 3, 1.0])


def test_corrupt_price_point_cannot_dominate_quantiles():
    z, opens = _panel(7, beta=0.0)
    bad = opens.copy()
    bad.iloc[500:520, 3] *= 2000  # a corrupt 2000x stretch in one series (like TIE 2010 in Qlib's store)
    sc = I.combine_components([(z, 1)])
    clean = I.quantile_stats(sc, I.fwd_returns(opens, 5), 5)["long_short_annual"]
    dirty = I.quantile_stats(sc, I.fwd_returns(bad, 5), 5)["long_short_annual"]
    assert abs(dirty - clean) < 0.05, (clean, dirty)
    el = pd.DataFrame(True, index=opens.index, columns=opens.columns)
    dq = I.extreme_moves(bad, el)
    assert dq["count"] >= 2 and dq["tickers"] == ["3"]


def test_rank_ic_matches_pandas_spearman():
    rng = np.random.default_rng(0)
    idx = pd.bdate_range("2020-01-01", periods=30)
    s = pd.DataFrame(rng.normal(size=(30, 12)), index=idx)
    r = pd.DataFrame(rng.normal(size=(30, 12)), index=idx)
    s.iloc[3, 2] = np.nan
    ic = I.daily_rank_ic(s, r)
    for d in idx[:5]:
        m = s.loc[d].notna() & r.loc[d].notna()
        assert abs(ic[d] - s.loc[d][m].corr(r.loc[d][m], method="spearman")) < 1e-12


def test_nw_tstat_penalises_autocorrelation():
    rng = np.random.default_rng(1)
    e = rng.normal(size=3000)
    x = pd.Series(np.convolve(e, np.ones(20) / 20, mode="same") + 0.02)  # MA(19): overlapping-label-like
    assert abs(I.nw_tstat(x, 40)) < abs(I.nw_tstat(x, 0)) / 2


# ---------------------------------------------------------------- multiple testing

def test_threshold_rises_with_trials_and_registry():
    t = [I.t_threshold(m) for m in (1, 3, 10, 30, 100)]
    assert all(b > a for a, b in zip(t[1:], t[2:])) and t[0] >= 2.0 and t[-1] > 3.4
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "reg.jsonl"
        f1 = {"name": "a", "hash": "h1", "components": []}
        f2 = {"name": "b", "hash": "h2", "components": []}
        assert I.registry_add(p, "QQQ", ["2008-01-01", "2020-01-01"], [f1, f2], [5, 20]) == 2
        assert I.registry_add(p, "QQQ", ["2008-01-01", "2020-01-01"], [f1], [5]) == 0  # deduped by hash
        assert I.registry_trials(p, "QQQ") == {"factors": 2, "tests": 4}
        I.registry_add(p, "QQQ", ["2008-01-01", "2020-01-01"], [f1], [60])  # new horizon counts
        I.registry_add(p, "SP500", ["2008-01-01", "2020-01-01"], [f1], [5])  # other universe is separate
        assert I.registry_trials(p, "QQQ") == {"factors": 2, "tests": 5}
        assert I.registry_trials(p, "SP500") == {"factors": 1, "tests": 1}
        assert len(p.read_text().splitlines()) == 4  # append-only
        assert I.t_threshold(I.registry_trials(p, "QQQ")["tests"]) > I.t_threshold(I.registry_trials(p, "SP500")["tests"])


# ---------------------------------------------------------------- end-to-end on synthetic panels

def _panel(seed, beta, n_days=1100, n_names=80):
    """Persistent score z (AR(1)); open-to-open return from day k to k+1 = beta * z(k-1) + noise."""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2010-01-04", periods=n_days)
    z = np.zeros((n_days, n_names))
    z[0] = rng.normal(size=n_names)
    for k in range(1, n_days):
        z[k] = 0.99 * z[k - 1] + np.sqrt(1 - 0.99 ** 2) * rng.normal(size=n_names)
    r = 0.0003 + 0.02 * rng.normal(size=(n_days, n_names))
    r[1:] += beta * z[:-1]
    opens = pd.DataFrame(100 * np.cumprod(1 + r, axis=0), index=idx)
    return pd.DataFrame(z, index=idx), opens


def _eval(score, opens, known=None, hs=(5, 20, 60)):
    rets = {h: I.fwd_returns(opens, h) for h in hs}
    el = pd.DataFrame(True, index=score.index, columns=score.columns)
    sc = I.combine_components([(score, 1)], el)
    return I.evaluate_factor(sc, rets, known or {}, 10.0, el)


def test_planted_signal_is_detected():
    z, opens = _panel(7, beta=0.002)
    res = _eval(z, opens)
    v = I.judge(res, I.t_threshold(3 * 3))
    assert v["verdict"] == "signal", (v, res["ic"])
    assert res["quantiles"]["long_short_net_annual"] > 0 and res["share_years_positive"] >= 2 / 3
    assert res["quantiles"]["monotonic"]
    assert 0 < res["turnover_top_quintile"] < 0.6


def test_pure_noise_gets_none():
    verdicts = []
    for seed in range(5):
        z, opens = _panel(100 + seed, beta=0.0)
        noise = pd.DataFrame(np.random.default_rng(seed).normal(size=z.shape), index=z.index).cumsum()
        res = _eval(noise, opens)
        verdicts.append(I.judge(res, I.t_threshold(3 * 3))["verdict"])
    assert "signal" not in verdicts and verdicts.count("none") >= 4, verdicts


def test_near_duplicate_of_momentum_is_capped():
    z, opens = _panel(7, beta=0.002)
    mom = z + 0.1 * pd.DataFrame(np.random.default_rng(3).normal(size=z.shape), index=z.index)
    res = _eval(z, opens, known={"momentum_12_1": mom, "reversal_1m": -z.shift(5)})
    assert res["corr_known"]["momentum_12_1"] > 0.8
    v = I.judge(res, I.t_threshold(9))
    assert v["verdict"] == "weak" and any("动量" in r for r in v["reasons_zh"]), v


def test_more_trials_can_flip_a_borderline_signal():
    z, opens = _panel(11, beta=0.00025)  # t about 3.2 at the best horizon
    res = _eval(z, opens)
    t = res["ic"][str(res["best_horizon"])]["t"]
    assert 2.5 < t < 4.5, t
    few = max(m for m in range(1, 1000) if I.t_threshold(m) < t)
    assert I.judge(res, I.t_threshold(few))["verdict"] == "signal"
    v = I.judge(res, I.t_threshold(few * 10))  # ten times more trials on the universe -> not a signal any more
    assert v["verdict"] == "weak" and any("门槛" in r for r in v["reasons_zh"]), v


# ---------------------------------------------------------------- $mkt (market return field)

def test_market_field_whitelisted_and_detected():
    expr = "Std($close/Ref($close,1)-1-Cov($close/Ref($close,1)-1,$mkt,252)/Var($mkt,252)*$mkt,252)"
    I.parse_expr(expr)  # accepted
    spec = {"factors": [{"name": "a", "components": [{"expr": "Std($close/Ref($close,1)-1,252)", "weight": -1}]},
                        {"name": "b", "components": [{"expr": expr, "weight": -1}]}]}
    assert I.uses_market(spec)
    assert not I.uses_market({"factors": spec["factors"][:1]})
    assert not I.uses_market({"factors": [{"name": "f", "components": [{"fundamental": "F_EP", "weight": 1}]}]})
    _raises(I.parse_expr, "$market", contains="不认识的数据字段")
    _raises(I.parse_expr, "Std($mkt,252)", contains="$mkt")  # same value for every stock: cannot rank


def test_market_return_is_point_in_time_equal_weight():
    idx = pd.bdate_range("2020-01-01", periods=6)
    cols = [f"T{i}" for i in range(25)]
    rng = np.random.default_rng(0)
    closes = pd.DataFrame(100 * np.cumprod(1 + rng.normal(0, 0.01, (6, 25)), axis=0), index=idx, columns=cols)
    el = pd.DataFrame(True, index=idx, columns=cols)
    el.iloc[3, :2] = False            # two names not members on day 3
    closes.iloc[2, 5] = np.nan        # no close on day 2 -> no return for T5 on days 2 and 3
    m = I.market_return(closes, el)
    r = closes / closes.shift(1) - 1
    exp3 = r.iloc[3].drop(["T0", "T1", "T5"]).mean()
    assert abs(m.iloc[3] - exp3) < 1e-12, (m.iloc[3], exp3)
    assert np.isnan(m.iloc[0])        # first day has no previous close
    # adding a later day (or changing it) never changes earlier values: no look-ahead
    more = pd.concat([closes, closes.iloc[[-1]].set_axis([idx[-1] + pd.offsets.BDay()]) * 5])
    m2 = I.market_return(more, el.reindex(more.index, fill_value=True))
    assert np.allclose(m2.iloc[:6].dropna(), m.dropna())
    # too few eligible names -> NaN, not a noisy mean
    el2 = el.copy(); el2.iloc[4, 5:] = False
    assert np.isnan(I.market_return(closes, el2).iloc[4])


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print("ALL PASSED")
