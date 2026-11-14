"""Regression tests for data corrections and report wording. Run: python test_qs_data.py"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qs_data as Dq  # noqa: E402
import qs_describe as W  # noqa: E402
import qs_membership as M  # noqa: E402

CAL = pd.bdate_range("2015-01-01", "2016-12-30")


def _series(seed, cal=CAL, start=100.0):
    r = np.random.default_rng(seed).normal(0, 0.02, len(cal))
    c = start * np.cumprod(1 + r)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": 1e6}, index=cal)


def _iv(rows):
    return pd.DataFrame(rows, columns=["ticker", "start", "end"]).assign(
        start=lambda d: pd.to_datetime(d.start), end=lambda d: pd.to_datetime(d.end))


def _shifted_reader(true: dict, stored_shift: dict, cal=CAL):
    """Shared store whose bar at slot i holds the real bar of slot i+stored_shift (dated early when +1)."""
    def read(t, k):
        if t not in true:
            return None
        v = true[t].values
        s = stored_shift.get(t, 0)
        stored = pd.DataFrame(v[s:] if s >= 0 else v[:s], columns=true[t].columns, index=cal[:len(v) - abs(s)])
        idx = cal.get_indexer(stored.index) + k
        ok = (idx >= 0) & (idx < len(cal))
        return pd.DataFrame(stored.values[ok], columns=stored.columns, index=cal[idx[ok]])
    return read


def test_date_alignment_measured_and_inferred_flagged():
    true = {"A": _series(1), "B": _series(2), "C": _series(3)}
    yahoo = {"A": true["A"], "B": true["B"]}               # C is not served by Yahoo
    read = _shifted_reader(true, {"A": 1, "B": 1, "C": 1})  # whole store dated one day early
    frames, prov, cons, votes = Dq.align_shared(["A", "B", "C"], read, yahoo, orig_end="2014-01-01")
    assert prov["A"] == {"shift": 1, "basis": "measured", "group": "extended", "corr": prov["A"]["corr"]}
    assert prov["A"]["corr"] > 0.99 and cons["extended"] == 1
    assert prov["C"]["shift"] == 1 and prov["C"]["basis"].startswith("inferred")
    # after correction C lines up with its true dates
    j = pd.concat([frames["C"]["close"], true["C"]["close"]], axis=1, join="inner").dropna()
    assert np.allclose(j.iloc[:, 0], j.iloc[:, 1])
    src = {"C": {"source": "shared-qlib", "reason": "not served by Yahoo", "verified": True}}
    unc = Dq.uncertain_corrections(prov, src, {}, used=["C"])
    assert [u["kind"] for u in unc] == ["inferred date shift"]


def test_symbol_reuse_rejected_with_price_evidence():
    iv = _iv([("X", "2015-01-01", "2016-12-30")])
    yahoo, shared = {"X": _series(10)}, {"X": _series(11)}  # same symbol, unrelated returns
    frames, prov = Dq.choose_sources(["X"], yahoo, shared, iv)
    assert prov["X"]["reason"].startswith("Yahoo symbol reused") and frames["X"] is shared["X"]
    assert prov["X"]["verified"] and Dq.uncertain_corrections({}, prov, {}, ["X"]) == []


def test_stale_shared_symbol_of_earlier_security_not_preferred():
    # COR case: the member (Cencora) is on Yahoo for its whole membership; the stale shared store's
    # COR is CoreSite, which stopped trading before most of the membership. Yahoo must win.
    iv = _iv([("COR", "2015-01-01", "2016-12-30")])
    yahoo = {"COR": _series(12)}
    shared = {"COR": _series(13, CAL[CAL <= "2015-03-31"])}
    frames, prov = Dq.choose_sources(["COR"], yahoo, shared, iv)
    assert frames["COR"] is yahoo["COR"] and prov["COR"]["reason"].startswith("shared-qlib symbol belongs")


def test_coverage_override_without_overlap_is_flagged():
    # FB case: Yahoo's symbol now belongs to a recent instrument; the old series lives in the shared store
    iv = _iv([("FB", "2015-01-01", "2015-12-31")])
    old, new = _series(20, CAL[CAL <= "2015-12-31"]), _series(21, CAL[CAL >= "2016-06-01"])
    frames, prov = Dq.choose_sources(["FB"], {"FB": new}, {"FB": old}, iv)
    assert frames["FB"] is old and prov["FB"]["reason"] == "coverage override" and not prov["FB"]["verified"]
    assert [u["kind"] for u in Dq.uncertain_corrections({}, prov, {}, ["FB"])] == ["source chosen by coverage only"]


def test_renames_verified_curated_and_contradicted():
    full_y = _series(30)
    iv = _iv([("OLD", "2015-01-01", "2015-12-31"), ("NEW", "2016-01-01", "2016-12-30"),
              ("CUR", "2015-01-01", "2015-12-31"), ("CURNEW", "2016-01-01", "2016-12-30"),
              ("BAD", "2015-01-01", "2015-12-31"), ("BADNEW", "2016-01-01", "2016-12-30")])
    frames = {"OLD": full_y[full_y.index <= "2015-06-30"], "NEW": full_y,           # old prices stop early, match NEW
              "CURNEW": _series(31),                                               # CUR has no prices anywhere
              "BAD": _series(32, CAL[CAL <= "2015-06-30"]), "BADNEW": _series(33)}  # curated but contradicted
    known = {"CUR": ("CURNEW", "2016-01-01"), "BAD": ("BADNEW", "2016-01-01")}
    r = Dq.detect_renames(frames, iv, known, today="2016-12-30")
    assert r["OLD"]["to"] == "NEW" and r["OLD"]["basis"] == "price-verified" and r["OLD"]["corr"] > 0.99
    assert r["CUR"]["basis"] == "curated" and "BAD" not in r
    unc = Dq.uncertain_corrections({}, {}, r, used=["OLD", "CUR"])
    assert [(u["ticker"], u["kind"]) for u in unc] == [("CUR", "curated rename")]
    assert "CUR→CURNEW (curated, NOT price-verified)" in W.renames({"renames_detail": r})
    assert "OLD→NEW (price-verified)" in W.renames({"renames_detail": r})


def test_flags_follow_the_series_actually_used():
    # FB case: coverage override on FB, but FB is then renamed to META with matching prices -> no flag for FB;
    # a rename target priced from Yahoo is not flagged for shared-store alignment.
    src = {"FB": {"source": "shared-qlib", "reason": "coverage override", "verified": False,
                  "shared_member_days": 10, "yahoo_member_days": 0},
           "META": {"source": "yahoo", "reason": "default", "verified": True},
           "EA": {"source": "shared-qlib", "reason": "not served by Yahoo", "verified": True}}
    al = {"FB": {"shift": 0, "basis": "inferred from group consensus"}, "META": {"shift": 1, "basis": "inferred from group consensus"},
          "EA": {"shift": 0, "basis": "inferred from group consensus"}}
    ren = {"FB": {"to": "META", "basis": "price-verified"}, "ERTS": {"to": "EA", "basis": "curated"}}
    unc = Dq.uncertain_corrections(al, src, ren, used=["FB", "META", "ERTS"])
    assert [(u["ticker"], u["kind"]) for u in unc] == [("ERTS", "curated rename"), ("ERTS", "unmeasured date alignment")]


def test_missing_member_prices_excluded_and_disclosed():
    cal = pd.bdate_range("2020-01-01", "2020-01-31")
    iv = _iv([("A", "2020-01-01", "2020-01-31"), ("B", "2020-01-01", "2020-01-31"), ("C", "2020-01-15", "2020-01-31")])
    member = M.member_matrix(iv, cal, ["A", "B", "C"])
    priced = pd.DataFrame({"A": True, "B": False, "C": cal >= "2020-01-27"}, index=cal)
    elig, never, partly, overall = Dq.member_price_coverage(member, priced, iv)
    assert not elig["B"].any() and never == {"B": ["2020-01-01..2020-01-31"]}
    assert set(partly) == {"C"} and not elig.loc[:"2020-01-14", "C"].any()
    assert abs(overall - elig.values.sum() / member.values.sum()) < 1e-12


# --- series quality ---------------------------------------------------------------------------

def test_corrupt_spike_dropped_and_disclosed():
    # CBE/TIE case: a span stored 1000x too high, then back to the right level
    f = _series(40)
    bad = f.index[100:110]
    g = f.copy()
    g.loc[bad, ["open", "high", "low", "close"]] *= 1000
    clean, rep = Dq.clean_series(g, [(CAL[0], CAL[-1])])
    assert rep["rejected"] is None and len(rep["spikes"]) == 1 and rep["spikes"][0]["bars"] == 10
    assert clean.index.equals(f.index.difference(bad)) and np.allclose(clean["close"], f["close"].drop(bad))
    assert clean["close"].pct_change().abs().max() < 0.5
    # HNZ case: alternating ~3x bars on consecutive days
    h = f.copy()
    for d in f.index[200:220:2]:
        h.loc[d, ["open", "high", "low", "close"]] /= 3.1
    clean, rep = Dq.clean_series(h, [(CAL[0], CAL[-1])])
    assert len(rep["spikes"]) == 10 and clean["close"].pct_change().abs().max() < 0.5
    # HNZ 2011 case: bars flip between two levels ~2.2x apart every few days (below the 2.5x spike size)
    q = f.copy()
    for k in range(300, 360, 6):
        q.loc[f.index[k:k + 3], ["open", "high", "low", "close"]] /= 2.2
    clean, rep = Dq.clean_series(q, [(CAL[0], CAL[-1])])
    assert len(rep["spikes"]) == 10 and clean["close"].pct_change().abs().max() < 0.5


def test_split_like_pair_dropped_confirmed_jump_and_crash_kept():
    f = _series(41)
    g = f.copy()
    g.loc[f.index[50:60], ["open", "high", "low", "close"]] *= 0.5     # exact 2:1 error, undone 10 bars later
    clean, rep = Dq.clean_series(g)
    assert len(rep["spikes"]) == 1 and len(clean) == len(f) - 10
    # a real move (HIG 2008: -52% then +102%) that the other source shows too is never touched
    h = f.copy()
    h.loc[f.index[300:325], ["open", "high", "low", "close"]] *= 0.48
    clean, rep = Dq.clean_series(h, confirm=h.copy())
    assert rep["spikes"] == [] and clean is h
    # an unreversed -80% day is kept (real crashes must not vanish) and disclosed
    k = f.copy()
    k.loc[f.index[400:], ["open", "high", "low", "close"]] *= 0.2
    clean, rep = Dq.clean_series(k)
    assert clean is k and [c["date"] for c in rep["crashes"]] == [str(f.index[400].date())]


def test_scale_break_keeps_member_segment_and_repeated_breaks_reject():
    f = _series(42)
    g = f.copy()
    g.loc[f.index[300:], ["open", "high", "low", "close"]] *= 9.0     # +800% overnight, never undone
    sp = [(CAL[0], CAL[250])]
    clean, rep = Dq.clean_series(g, sp)
    assert rep["rejected"] is None and len(rep["breaks"]) == 1 and clean.index[-1] == f.index[299]
    assert rep["excluded"] == [{"from": str(f.index[300].date()), "to": str(f.index[-1].date()), "bars": len(f) - 300}]
    h = f.copy()
    for k in (100, 200, 300):  # CHK case: a +300% step every few months
        h.loc[f.index[k:], ["open", "high", "low", "close"]] *= 5.0
    clean, rep = Dq.clean_series(h, sp)
    assert clean is None and "3 scale breaks" in rep["rejected"]


def test_bad_bars_fields_stale_padding_and_sparse_series():
    f = _series(43)
    g = f.copy()
    g.loc[f.index[10], "close"] = 0.0
    g.loc[f.index[11], "close"] = -1.0
    g.loc[f.index[12], "open"] = 0.0
    g.loc[f.index[13], "high"] = g.loc[f.index[13], "close"] * 50
    clean, rep = Dq.clean_series(g)
    assert rep["bad_bars"] == 2 and rep["fixed_fields"] == 2 and len(clean) == len(f) - 2
    assert clean.loc[f.index[12], "open"] == clean.loc[f.index[12], "close"]
    # SW case: a foreign listing padded with untraded bars (volume 0, flat price)
    s = f.copy()
    s.iloc[100:200, :4] = s["close"].iloc[99]
    s.iloc[100:200, 4] = 0
    clean, rep = Dq.clean_series(s)
    assert rep["stale_bars"] == 100 and len(clean) == len(f) - 100
    # EP/MEE case: bars on a fraction of the trading days
    sparse = f.iloc[::3]
    clean, rep = Dq.clean_series(sparse, [(CAL[0], CAL[-1])])
    assert clean is None and rep["rejected"].startswith("bars on only")
    # too much of the membership mis-scaled: not trusted at all
    m = f.copy()
    for k in range(20, 500, 40):
        m.loc[f.index[k:k + 15], ["open", "high", "low", "close"]] *= 100
    clean, rep = Dq.clean_series(m, [(CAL[0], CAL[-1])])
    assert clean is None and "mis-scaled" in rep["rejected"]


# --- company identity ---------------------------------------------------------------------------

def _mkt(seed=99, cal=CAL):
    return pd.Series(np.random.default_rng(seed).normal(0, 0.01, len(cal)), index=cal)


def _stock(mkt, seed, beta=1.0, start=50.0, vol=1e6, cal=None):
    cal = mkt.index if cal is None else cal
    r = beta * mkt.reindex(cal).values + np.random.default_rng(seed).normal(0, 0.01, len(cal))
    c = start * np.cumprod(1 + r)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": vol}, index=cal)


def test_illiquid_yahoo_rejected_and_the_shared_member_kept():
    # EP/CPWR case: Yahoo's symbol now belongs to a penny stock; the shared store has the member
    iv = _iv([("EP", "2015-01-01", "2016-12-30")])
    yahoo = {"EP": _series(50, start=2.0).assign(volume=1000.0)}
    shared = {"EP": _series(51)}
    frames, prov = Dq.choose_sources(["EP"], yahoo, shared, iv)
    assert frames["EP"] is shared["EP"] and prov["EP"]["source"] == "shared-qlib"
    assert prov["EP"]["rejected"]["yahoo"].startswith("identity: median dollar volume")


def test_late_listed_illiquid_yahoo_and_its_shared_twin_rejected():
    # SUN/SII case: the Yahoo series starts near the end of the membership (a newly listed company);
    # the shared store holds the same new company (returns match), so it is rejected with it
    iv = _iv([("SUN", "2015-01-01", "2016-06-30")])
    late = _series(52, CAL[CAL >= "2016-05-02"], start=7.0).assign(volume=1e5)
    shared = {"SUN": late.copy()}  # the shared store's scaled units: price / 7, volume * 7 (and then some)
    shared["SUN"][["open", "high", "low", "close"]] /= 7.0
    shared["SUN"]["volume"] = 1e9
    frames, prov = Dq.choose_sources(["SUN"], {"SUN": late}, shared, iv)
    assert "SUN" not in frames and prov["SUN"]["source"] == "none"
    assert prov["SUN"]["rejected"]["yahoo"].startswith("identity:")
    assert prov["SUN"]["rejected"]["shared-qlib"].startswith("identity: same security as the rejected yahoo")
    # a liquid series that starts mid-membership (the membership file's start is too early, e.g. AMCR) stays
    big = _series(53, CAL[CAL >= "2016-05-02"]).assign(volume=1e6)
    frames, prov = Dq.choose_sources(["SUN"], {"SUN": big}, {}, iv)
    assert frames["SUN"] is big


def test_recycled_symbol_at_the_switch_point_rejected():
    # the member's shared history ends; Yahoo's series for the symbol begins after it at another level
    iv = _iv([("X", "2015-01-01", "2016-12-30")])
    old = _series(54, CAL[CAL <= "2015-12-31"], start=1.0).assign(volume=1e8)
    new = _series(55, CAL[CAL >= "2016-01-04"], start=40.0)
    frames, prov = Dq.choose_sources(["X"], {"X": new}, {"X": old}, iv)
    assert frames["X"] is old and "level jump" in prov["X"]["rejected"]["yahoo"]


def test_market_uncorrelated_series_rejected():
    # GAS/HAR/POM case: a series that does not move with the market over years of membership
    cal = pd.bdate_range("2013-01-01", "2016-12-30")
    mkt = _mkt(cal=cal)
    iv = _iv([("JNK", "2013-01-01", "2016-12-30"), ("OK", "2013-01-01", "2016-12-30")])
    shared = {"JNK": _stock(mkt, 1, beta=0.0), "OK": _stock(mkt, 2, beta=1.0)}
    frames, prov = Dq.choose_sources(["JNK", "OK"], {}, shared, iv, mkt=mkt)
    assert "JNK" not in frames and "correlate only" in prov["JNK"]["rejected"]["shared-qlib"]
    assert frames["OK"] is shared["OK"]


def test_acquired_member_later_owner_rejected_other_security_cut_and_later_spell_kept():
    cal = pd.bdate_range("2012-01-02", "2016-12-30")
    mkt = _mkt(cal=cal)
    iv = _iv([("LSI", "2012-01-02", "2014-05-07"), ("CBE", "2012-01-02", "2014-05-07"),
              ("CEG", "2012-01-02", "2013-03-12"), ("CEG", "2015-06-01", "2016-12-30")])
    iv["end_note"] = ["acquired", "acquired", "acquired", ""]
    # LSI case: one normally traded company straight through the acquisition date: a later owner's history
    lsi = _stock(mkt, 3, beta=1.0)
    # CBE case: the member until the acquisition, then an unrelated thin security appended under the symbol
    cbe = pd.concat([_stock(mkt, 4, cal=cal[cal <= "2014-05-06"]),
                     _stock(mkt, 5, beta=0.0, start=0.05, cal=cal[cal >= "2014-05-07"])])  # switches a day early
    # CEG case: acquired in 2013; the symbol's new owner (listed 2015) joined the index later
    ceg = _stock(mkt, 6, cal=cal[cal >= "2015-01-02"])
    frames, prov = Dq.choose_sources(["LSI", "CBE", "CEG"], {"CEG": ceg}, {"LSI": lsi, "CBE": cbe}, iv, mkt=mkt)
    assert "LSI" not in frames and "later owner" in prov["LSI"]["rejected"]["shared-qlib"]
    assert frames["CBE"].index[-1] == pd.Timestamp("2014-05-06") and "cut" in prov["CBE"]["cut"]["shared-qlib"]
    assert frames["CEG"] is ceg


def test_curated_identity_overrides_gold_and_vip():
    iv = _iv([("GOLD", "2015-01-01", "2016-06-30"), ("VIP", "2015-01-01", "2016-06-30"),
              ("VEON", "2017-01-02", "2017-01-03")])
    y, s = _series(60), _series(61)
    frames, prov = Dq.choose_sources(["GOLD", "VIP"], {"GOLD": y, "VIP": y}, {"GOLD": s, "VIP": s}, iv)
    assert not frames and {prov[t]["source"] for t in ("GOLD", "VIP")} == {"none"}
    assert prov["GOLD"]["rejected"]["shared-qlib"].startswith("curated identity override: ")
    # VIP is then priced through its curated rename to VEON (reported as not price-verified)
    r = Dq.detect_renames({"VEON": _series(62)}, iv[iv.ticker == "VIP"], {"VIP": ("VEON", "2017-03-30")},
                          today="2016-12-30")
    assert r["VIP"]["to"] == "VEON" and r["VIP"]["basis"] == "curated"


def test_same_security_sources_merged_and_spike_refilled():
    # shared covers more of the membership but has a mis-scaled span; Yahoo is the same security from
    # mid-2015 on and runs further: the span is refilled from Yahoo and Yahoo's later bars are appended
    iv = _iv([("M", "2015-01-01", "2016-12-30")])
    full = _series(63)
    shared = full[full.index <= "2016-06-30"].copy()
    span = shared.index[(shared.index >= "2016-02-01") & (shared.index < "2016-02-15")]
    shared.loc[span, ["open", "high", "low", "close"]] *= 1000
    yahoo = full[full.index >= "2015-09-01"].copy()
    yahoo[["open", "high", "low", "close"]] *= 3.0   # another price level (adjustment), same returns
    frames, prov = Dq.choose_sources(["M"], {"M": yahoo}, {"M": shared}, iv)
    f = frames["M"]
    assert prov["M"]["reason"] == "coverage override" and prov["M"]["verified"]
    assert prov["M"]["merged"] == {"from": "yahoo", "after": int((full.index > "2016-06-30").sum()), "repaired": len(span)}
    assert f.index.equals(full.index) and np.allclose(f["close"], full["close"])


def test_gap_at_source_cutoff_is_not_a_delisting():
    ends = ["2020-11-10"] * 200 + ["2024-12-27"] * 30 + ["2019-03-01", "2018-05-02"]
    cut = Dq.store_cutoffs(ends, min_count=25)
    assert cut == [pd.Timestamp("2020-11-10"), pd.Timestamp("2024-12-27")]
    assert Dq.end_kind("2020-11-09", "2026-11-06", cut) == "gap"
    assert Dq.end_kind("2019-03-01", "2026-11-06", cut) == "delisted"
    assert Dq.end_kind("2026-11-05", "2026-11-06", cut) == "listed"
    cal = pd.bdate_range("2020-01-01", "2021-12-31")
    iv = _iv([("A", "2020-01-01", "2021-12-31"), ("B", "2020-01-01", "2021-12-31"), ("C", "2021-01-01", "2021-12-31")])
    member = M.member_matrix(iv, cal, ["A", "B", "C"])
    elig = pd.DataFrame({"A": True, "B": cal <= "2020-11-10", "C": False}, index=cal) & member
    rows = {r["year"]: r for r in Dq.member_gaps_by_year(member, elig, {"B": "2020-11-10"})}
    b20 = int(((cal > "2020-11-10") & (cal.year == 2020)).sum())
    assert rows[2020]["unpriced"] == rows[2020]["after_cutoff"] == b20 and rows[2020]["never_priced"] == 0
    n21 = int((cal.year == 2021).sum())
    assert rows[2021] == {"year": 2021, "member_days": 3 * n21, "unpriced": 2 * n21, "share": round(2 / 3, 4),
                          "after_cutoff": n21, "never_priced": n21, "other": 0}


SP = {"holdout_start": "2024-10-16", "end": "2026-10-16"}
UNI_PIT = {"membership_kind": "point-in-time", "source": "Nasdaq endpoint", "as_of": "2026-10-19"}
UNI_SNAP = {"membership_kind": "snapshot", "source": "user ticker list"}
HO_NEW = {"holdout_status": "untouched", "previous_examinations": []}
HO_SEEN = {"holdout_status": "PREVIOUSLY EXAMINED", "previous_examinations": [{"run_dir": "x", "at": "t"}]}


def _render(uni, ho, attempts=1):
    m, h = W.membership(uni), W.holdout(ho, SP, attempts)
    text = "\n".join([f"**Membership:** {m['label']}. **Holdout:** {h['status']}.", m["summary"], m["bias"],
                      h["headline"], h["chart_title"], f"- {m['limitation']}", f"- {h['limitation']}",
                      "VERDICT" + h["verdict_suffix"]])
    return text, h


def test_report_descriptions_follow_metadata():
    for uni in (UNI_PIT, UNI_SNAP):
        for ho in (HO_NEW, HO_SEEN):
            text, h = _render(uni, ho)
            assert W.contradictions(text, uni, h) == [], (uni["membership_kind"], ho["holdout_status"])
            assert ("previously examined" in text) == (ho is HO_SEEN)
            assert ("SNAPSHOT" in text) == (uni is UNI_SNAP)
    # a second holdout attempt in the same run also counts as examined
    assert W.holdout(HO_NEW, SP, attempts=2)["examined"]


def test_contradiction_check_catches_stale_wording():
    text, h = _render(UNI_PIT, HO_SEEN)
    for bad in ["- Membership is today's constituent list (survivorship bias).",
                "NAV per unit: development period, then locked holdout",
                "Only the holdout (2024-10-16 to 2026-10-16) is a clean test, and it is short.",
                "Ticker renames detected by price match: KFT->MDLZ"]:
        assert W.contradictions(text + "\n" + bad, UNI_PIT, h), bad
    text2, h2 = _render(UNI_SNAP, HO_NEW)
    assert W.contradictions(text2 + "\nthis window was previously examined", UNI_SNAP, h2)
    assert W.contradictions(text2 + "\nMembership: point-in-time (historical)", UNI_SNAP, h2)


def test_corrections_text_reports_unknown_provenance_as_unverified():
    assert "not recorded" in W.corrections({})[0]
    assert "backed by price evidence" in W.corrections({"uncertain_corrections": []})[0]
    lines = W.corrections({"uncertain_corrections": [{"ticker": "KFT", "kind": "curated rename", "detail": ""}]})
    assert "not price-verified" in lines[0] and "KFT" in lines[1]


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                fails += 1
                import traceback
                print(f"FAIL {name}: {e!r}\n{traceback.format_exc()[-600:]}")
    print("ALL PASSED" if not fails else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
