"""Regression tests for SEC fundamentals and sector neutrality. Run: python test_qs_fund.py (no network)."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qs_core as C  # noqa: E402
import qs_fundamentals as F  # noqa: E402


def _fact(start, end, val, filed, fp="Q1", form="10-Q"):
    r = {"end": end, "val": val, "filed": filed, "fp": fp, "form": form}
    if start:
        r["start"] = start
    return r


def _facts(us=None, dei=None):
    return {"facts": {"us-gaap": {c: {"units": {"USD": v}} for c, v in (us or {}).items()},
                      "dei": {c: {"units": {"USD": v}} for c, v in (dei or {}).items()}}}


def test_ttm_from_ytd_cash_flow():
    """Cash-flow statements report year-to-date only: quarters come from differences; TTM after 4 quarters."""
    fy = "2019-01-01"
    rec = F._records(_facts({"NetCashProvidedByUsedInOperatingActivities": [
        _fact(fy, "2019-03-31", 10, "2019-04-25"), _fact(fy, "2019-06-30", 25, "2019-07-25"),
        _fact(fy, "2019-09-30", 45, "2019-10-25"), _fact(fy, "2019-12-31", 70, "2020-02-20", "FY", "10-K"),
        _fact("2020-01-01", "2020-03-31", 12, "2020-04-25")]}), F.CFO)
    q = F.quarters(rec).set_index("end")["val"]
    assert list(q.values) == [10, 15, 20, 25, 12], q
    t = F.ttm(rec).set_index("end")
    assert t.loc[pd.Timestamp("2019-12-31"), "val"] == 70          # annual fact
    assert t.loc[pd.Timestamp("2020-03-31"), "val"] == 15 + 20 + 25 + 12
    assert t.loc[pd.Timestamp("2020-03-31"), "filed"] == pd.Timestamp("2020-04-25")


def test_point_in_time_and_restatement():
    """Usable only the day after filing; a later restatement of the same period is ignored."""
    rec = F._records(_facts({"Assets": [_fact(None, "2020-03-31", 100, "2020-05-01"),
                                        _fact(None, "2020-03-31", 999, "2021-05-01")]}), F.ASSETS)
    dates = pd.bdate_range("2020-04-29", "2020-05-06")
    s = F.asof(rec, dates, 460)
    assert np.isnan(s[pd.Timestamp("2020-05-01")]), "visible on its filing day"
    assert s[pd.Timestamp("2020-05-04")] == 100
    s2 = F.asof(rec, pd.DatetimeIndex([pd.Timestamp("2021-06-01")]), 460)
    assert s2.iloc[0] == 100, "restated value leaked in"


def test_fact_dated_after_its_filing_is_ignored():
    """A 10-Q filed 2012-04-24 tagging public float 'as of 2012-06-30' must not read the June price."""
    rec = F._records(_facts(dei={"EntityPublicFloat": [_fact(None, "2011-06-30", 4e10, "2012-02-16"),
                                                       _fact(None, "2012-06-30", 4e10, "2012-04-24")]}),
                     ["EntityPublicFloat"], taxonomy="dei")
    assert list(rec["end"]) == [pd.Timestamp("2011-06-30")]


def test_same_day_filings_pick_latest_period():
    rec = pd.DataFrame({"end": pd.to_datetime(["2014-09-30", "2015-03-31", "2015-06-30"]), "val": [1.0, 2.0, 3.0],
                        "filed": pd.to_datetime(["2015-08-07"] * 3)})
    s = F.asof(rec.sample(frac=1, random_state=1), pd.DatetimeIndex([pd.Timestamp("2016-03-01")]), 460)
    assert s.iloc[0] == 3.0


def test_late_filing_for_older_period_does_not_override():
    rec = pd.DataFrame({"end": pd.to_datetime(["2020-06-30", "2020-03-31"]), "val": [2.0, 1.0],
                        "filed": pd.to_datetime(["2020-08-01", "2020-09-01"])})
    s = F.asof(rec, pd.DatetimeIndex([pd.Timestamp("2020-09-15")]), 460)
    assert s.iloc[0] == 2.0


def test_stale_values_expire():
    rec = pd.DataFrame({"end": pd.to_datetime(["2018-12-31"]), "val": [5.0], "filed": pd.to_datetime(["2019-02-01"])})
    s = F.asof(rec, pd.DatetimeIndex(pd.to_datetime(["2019-06-03", "2020-06-01"])), 460)
    assert s.iloc[0] == 5.0 and np.isnan(s.iloc[1])


def test_market_value_is_split_proof():
    """A 2:1 split leaves the adjusted close continuous, so the float-based market value is unchanged."""
    dates = pd.bdate_range("2020-01-01", "2020-12-31")
    adj = pd.Series(np.linspace(50, 60, len(dates)), index=dates)  # adjusted for a mid-year split
    facts = _facts(dei={"EntityPublicFloat": [_fact(None, "2020-01-31", 5e9, "2020-02-15", "FY", "10-K")]},
                   us={"NetIncomeLoss": [_fact("2019-01-01", "2019-12-31", 2.5e8, "2020-02-15", "FY", "10-K")],
                       "Assets": [_fact(None, "2019-12-31", 1e10, "2020-02-15", "FY", "10-K")]})
    p = F.company_panel(facts, dates, adj)
    d = pd.Timestamp("2020-11-02")
    expected = 5e9 * adj[d] / adj.asof(pd.Timestamp("2020-01-31"))
    assert abs(np.exp(p.loc[d, "F_SIZE"]) / expected - 1) < 1e-9
    assert abs(p.loc[d, "F_EP"] - 2.5e8 / expected) < 1e-12
    assert np.isnan(p.loc[pd.Timestamp("2020-02-14"), "F_EP"]), "float used before it was filed"


def test_truncate_matches_point_in_time():
    dates = pd.bdate_range("2019-01-01", "2020-12-31")
    px = pd.Series(np.linspace(10, 20, len(dates)), index=dates)
    fy = "2019-01-01"
    facts = _facts(us={"NetIncomeLoss": [_fact(fy, "2019-03-31", 1, "2019-05-01"), _fact(fy, "2019-06-30", 3, "2019-08-01"),
                                         _fact(fy, "2019-09-30", 6, "2019-11-01"), _fact(fy, "2019-12-31", 10, "2020-02-15", "FY", "10-K"),
                                         _fact("2020-01-01", "2020-03-31", 4, "2020-05-01")],
                       "Assets": [_fact(None, "2019-12-31", 100, "2020-02-15"), _fact(None, "2020-03-31", 110, "2020-05-01")]},
                   dei={"EntityPublicFloat": [_fact(None, "2019-06-30", 500, "2020-02-15")]})
    cut = pd.Timestamp("2020-03-02")
    full = F.company_panel(facts, dates, px).loc[cut]
    past = F.company_panel(F.truncate(facts, cut), dates[dates <= cut], px.loc[:cut]).loc[cut]
    pd.testing.assert_series_equal(full, past, check_names=False)


class _FakeSec:
    """XOM-like case: the current CIK is a 2026 holding company with a short history; the
    operating history sits under a predecessor CIK; full-text search also returns another
    company (EOG-like) that trades under its own symbol."""
    def __init__(self):
        span = lambda a, b: _facts(us={"Assets": [_fact(None, d.strftime("%Y-%m-%d"), 1, d.strftime("%Y-%m-%d"))  # noqa: E731
                                                  for d in pd.date_range(a, b, freq="QS")]},
                                   dei={"EntityPublicFloat": [_fact(None, a, 5e10, a)]})
        self.facts = {1: span("2026-03-01", "2026-09-01"), 2: span("2009-08-01", "2026-05-01"), 3: span("2009-08-01", "2026-05-01")}
        self.subs = {1: {"tickers": ["XOM"]}, 2: {"tickers": []}, 3: {"tickers": ["EOG"]}}

    def current_tickers(self):
        return {"0": {"ticker": "XOM", "cik_str": 1, "title": "ExxonMobil Holdings Corp"},
                "1": {"ticker": "EOG", "cik_str": 3, "title": "EOG Resources"}}

    def company_facts(self, cik):
        return self.facts.get(cik)

    def submissions(self, cik):
        return self.subs.get(cik)

    def get_json(self, url, *a, **k):
        return {"hits": {"hits": [{"_id": "2", "_source": {"entity": "EXXON MOBIL CORP"}}]}}

    def search_symbol(self, t, a, b):
        from collections import Counter
        return Counter({3: 5})


def test_reorganised_company_uses_predecessor_and_rejects_other_symbol():
    assert F.clean_name("ExxonMobil Holdings Corp") == F.clean_name("EXXON MOBIL CORP") == "EXXONMOBIL"
    m = F.resolve_ciks(_FakeSec(), {"XOM": (pd.Timestamp("2008-01-02"), pd.Timestamp("2026-10-16"))}, {}, log=lambda *_: None)["XOM"]
    assert m["ciks"] == [1, 2], m
    assert m["uncertain"] and "predecessor" in m["basis"]
    merged = F.merge_facts([_FakeSec().facts[1], _FakeSec().facts[2]])
    assert len(merged["facts"]["us-gaap"]["Assets"]["units"]["USD"]) == \
        sum(len(_FakeSec().facts[c]["facts"]["us-gaap"]["Assets"]["units"]["USD"]) for c in (1, 2))


def test_search_candidate_trading_under_other_symbol_is_rejected():
    fake = _FakeSec()
    fake.get_json = lambda *a, **k: {}  # no predecessor found
    m = F.resolve_ciks(fake, {"XOM": (pd.Timestamp("2008-01-02"), pd.Timestamp("2026-10-16"))}, {}, log=lambda *_: None)["XOM"]
    assert m["cik"] is None and "another symbol" in m["basis"], m


def test_sic_sectors():
    assert F.sector_of_sic(3674) == "Information Technology"
    assert F.sector_of_sic(2834) == "Health Care"
    assert F.sector_of_sic(1311) == "Energy"
    assert F.sector_of_sic(6022) == "Financials"
    assert F.sector_of_sic(6798) == "Real Estate"
    assert F.sector_of_sic(4911) == "Utilities"
    assert F.sector_of_sic(5331) == "Consumer Discretionary"
    assert F.sector_of_sic(None) == "Unknown"


def test_sector_counts_and_balanced_targets():
    cnt = C.sector_counts(pd.Series({"A": 50, "B": 30, "C": 20, "D": 0}), 10)
    assert cnt.sum() == 10 and cnt["A"] == 5 and cnt["B"] == 3 and cnt["C"] == 2
    small = C.sector_counts(pd.Series({"A": 1, "B": 9}), 4)
    assert small.sum() == 4 and small["A"] <= 1
    d = pd.Timestamp("2020-01-02")
    tick = [f"A{i}" for i in range(6)] + [f"B{i}" for i in range(4)]
    sectors = {t: t[0] for t in tick}
    scores = pd.DataFrame([[float(i) for i in range(10)]], index=[d], columns=tick)  # B names score highest
    w = C.build_targets_balanced(scores, sectors, [d], 5)[d]
    assert sorted(w.index) == ["A3", "A4", "A5", "B2", "B3"], w.index.tolist()
    assert abs(w.sum() - 1) < 1e-12


def _strategy_and_scores(seed=0, n=40, dates=30, k=8):
    rng = np.random.default_rng(seed)
    cal = pd.bdate_range("2020-01-01", periods=dates * 5)
    sig = list(cal[::5])
    tick = [f"{'AB'[i % 2]}{i}" for i in range(n)]
    sectors = {t: t[0] for t in tick}
    # persistent strategy scores (low turnover) and fresh random baseline scores
    base = rng.normal(size=n)
    strat = pd.DataFrame([base + 0.3 * rng.normal(size=n) for _ in sig], index=sig, columns=tick)
    tg = C.build_targets_balanced(strat, sectors, sig, k)
    rnd = pd.DataFrame(rng.random((len(sig), n)), index=sig, columns=tick)
    return tg, rnd, sectors, cal


def test_matched_baseline_keeps_strategy_turnover_and_sector_mix():
    tg, rnd, sectors, _ = _strategy_and_scores()
    mt = C.matched_targets(rnd, tg, sectors)
    ds = sorted(tg)
    assert sorted(mt) == ds
    for a, b in zip(ds, ds[1:]):
        for g in "AB":
            s_a = {t for t in tg[a].index if sectors[t] == g}
            s_b = {t for t in tg[b].index if sectors[t] == g}
            m_a = {t for t in mt[a].index if sectors[t] == g}
            m_b = {t for t in mt[b].index if sectors[t] == g}
            assert len(m_b) == len(s_b)
            assert len(m_a & m_b) == len(s_a & s_b), (b, g)
    replaced_s = sum(len(set(tg[a].index) - set(tg[b].index)) for a, b in zip(ds, ds[1:]))
    replaced_old = sum(len(set(x.index) - set(y.index)) for x, y in
                       zip(*(lambda t: ([t[d] for d in ds[:-1]], [t[d] for d in ds[1:]]))(C.build_targets_balanced(rnd, sectors, ds, 8))))
    assert replaced_old > 2 * replaced_s, "fixture should show the old random baseline over-trading"


def test_matched_momentum_keeps_its_best_holdings():
    d0, d1 = pd.Timestamp("2020-01-02"), pd.Timestamp("2020-01-09")
    tg = {d0: pd.Series(0.5, index=["S1", "S2"]), d1: pd.Series(0.5, index=["S1", "S3"])}  # strategy keeps 1
    mom = pd.DataFrame({"S1": [1, 0.1], "S2": [2, 0.9], "S3": [0, 0.5], "S4": [0, 0.8]}, index=[d0, d1])
    mt = C.matched_targets(mom, tg)
    assert sorted(mt[d0].index) == ["S1", "S2"]
    assert sorted(mt[d1].index) == ["S2", "S4"], mt[d1].index.tolist()  # keeps best held (S2), adds best new (S4)


def test_matched_random_baseline_trades_like_the_strategy():
    tg, rnd, sectors, cal = _strategy_and_scores(seed=3)
    steps = 1 + 0.01 * np.random.default_rng(1).normal(size=(len(cal), len(rnd.columns)))
    px = pd.DataFrame(100.0 * np.cumprod(steps, axis=0), index=cal, columns=rnd.columns)
    a = C.simulate(px, px, tg, 10, start=cal[0], end=cal[-1])["traded"].sum()
    b = C.simulate(px, px, C.matched_targets(rnd, tg, sectors), 10, start=cal[0], end=cal[-1])["traded"].sum()
    assert abs(b / a - 1) < 0.25, (a, b)


def test_sector_demean():
    idx = pd.MultiIndex.from_tuples([(pd.Timestamp("2020-01-02"), t) for t in ["A1", "A2", "B1", "B2"]],
                                    names=["datetime", "instrument"])
    lab = pd.Series([0.10, 0.20, -0.05, 0.05], index=idx)
    out = C.sector_demean(lab, {"A1": "A", "A2": "A", "B1": "B", "B2": "B"})
    assert np.allclose(out.values, [-0.05, 0.05, -0.05, 0.05])


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print("ALL PASSED")
