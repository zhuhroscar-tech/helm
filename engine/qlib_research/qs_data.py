"""Price-source selection and data corrections for the quant-strategy engine.

Pure functions (no I/O except through the callables passed in), so every correction can be
unit-tested. Each correction records its evidence; anything not backed by price evidence is
returned in `uncertain` and must be reported as such, never as verified.

Corrections
  * date alignment of the shared Qlib store: shift measured per ticker against Yahoo
    ("measured"); otherwise the consensus of the ticker's group ("inferred" -> uncertain)
  * source choice per ticker: Yahoo unless (a) the shared series covers more membership days
    ("coverage override" -> uncertain unless prices overlap and agree) or (b) the Yahoo symbol's
    returns contradict the shared series ("symbol reuse", price evidence)
  * renames: price-verified (old series matches the successor inside the old membership) or
    curated (old symbol has no usable prices -> uncertain)
  * series quality (clean_series), applied to every candidate series before the choice:
      - bars with a non-positive / missing close are dropped; open/high/low that are non-positive or more
        than 4x away from the close are set to the close; untraded padding bars (volume 0, all prices equal
        to the previous close) are dropped
      - spikes: a jump of >= 2.5x (or an exact split-like 2x/3x, or >= 1.8x undone within 10 bars) that is
        undone within 126 bars, the price
        returning to its pre-jump level, opens a span of mis-scaled bars; the span is dropped. A >= 2.5x
        jump within 5 bars of either end with nothing after it is an edge spike and is dropped too
      - scale breaks: an unreversed single-day rise of more than +300% is not a trade; the series is cut at
        the break and only the segment covering most membership days is kept (more than 2 breaks: rejected)
      - a jump that the other source confirms on the same day (+-1) is real and never touched; unreversed
        falls of more than 75% are kept (real crashes must not be hidden) and only disclosed
      - rejected outright: > 20% of membership bars mis-scaled, or bars on < 60% of membership trading days
    A dropped span is refilled from the other source only when that source is the same security
    (return corr > MATCH) and its price ratio to the cleaned series is stable next to the span.
  * company identity, before a series is attached to a member:
      - a Yahoo series whose median dollar volume during the membership is < $2.5M/day, or that has no
        volume, is a different (small or untraded) company using the symbol
      - a Yahoo series that begins where the member's shared history ends (no overlap) with a level jump
        of more than 50% is a new company on a recycled symbol
      - a shared series whose median dollar volume during the membership is < $2.5M/day is not the member
        either (the shared store's dollar volume is never below Yahoo's for the same security)
      - a series that only starts more than 10 business days into a membership spell (the security listed
        mid-membership) must trade at least $15M/day during the membership
      - a series whose daily returns correlate < 0.15 with the equal-weight market (median return of all
        Yahoo series) over >= 500 membership days is not a listed large company
      - member removed as "acquired" (end_note from the membership file): its own shares stopped trading.
        A series that keeps trading afterwards as the same kind of security (market corr >= 0.3 before and
        after) is a later owner's whole history under the recycled symbol and is rejected; otherwise the
        bars after the acquisition belong to another security and are cut
      - a source rejected on identity takes a matching (corr > MATCH) other source down with it
      - a chosen series with no prices inside the membership is not attached at all
      - IDENTITY_OVERRIDES: curated cases no price rule can decide, each with its price evidence
    Two verified sources of the same security are merged: the chosen one is extended with the other's bars
    before/after its own history (and its dropped spans refilled), scaled at each junction.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

MATCH = 0.98      # returns correlation for "same security"
REUSE = 0.90      # below this the Yahoo symbol is a different security
SHIFT_OK = 0.95   # minimum correlation for a shift measurement to count
MIN_OVERLAP = 60  # trading days

SPIKE = float(np.log(2.5))          # |log return| that can open a mis-scaled span
SPLIT_LIKE = float(np.log(1.9))     # smaller jumps count only at an exact split-like ratio (2 or 3)...
QUICK = float(np.log(1.8))          # ...or, from 1.8x, when undone within QUICK_BARS (HNZ 2011: ~2.2x flips)
QUICK_BARS = 10
BREAK_UP = float(np.log(4.0))       # +300% in one day, not reversed: a scale break, not a trade
CRASH = float(np.log(0.25))         # -75% in one day, not reversed: kept, disclosed
SPIKE_MAX_BARS = 126                # a mis-scaled span must be undone within ~6 months
EDGE_BARS = 5                       # a big jump this close to either end with nothing beyond it: edge spike
MAX_DROP_SHARE = 0.20               # more membership bars mis-scaled than this: the series is not trusted
MIN_DENSITY = 0.60                  # bars on fewer membership trading days than this: not a traded record
MIN_DOLLAR_VOL = 2.5e6              # median $/day during membership; every real index member trades far more
JUNCTION_JUMP = float(np.log(1.5))  # level jump at a source switch that marks a recycled symbol
LATE_DOLLAR_VOL = 15e6              # a series that only starts mid-membership must at least trade like a large cap
LATE_BDAYS = 10                     # "starts mid-membership": more than this many business days after the spell start
MIN_MKT_CORR = 0.15                 # daily-return corr with the equal-weight market below this over...
MKT_MIN_DAYS = 500                  # ...this many membership days: not a listed large company
ACQ_GRACE = pd.Timedelta(days=30)   # bars allowed after an "acquired" removal before the series counts as continuing
CONTINUITY_CORR = 0.30              # market corr both before and after the acquisition: the same kind of security

# Cases no price rule can decide (both sources look plausible but belong to other companies).
# Each entry records its price evidence; they are reported as curated, never as price rules.
IDENTITY_OVERRIDES = {
    "GOLD": {"reject": ("yahoo", "shared-qlib"),
             "why": "Nasdaq-100 member GOLD (2011-12..2013-11) was Randgold Resources (name from the Nasdaq "
                    "weighting endpoint). The shared store's GOLD is Barrick Gold's history (return corr 0.99997 "
                    "over 3238 days with Yahoo 'B', Barrick's current symbol; Barrick took GOLD on 2019-01-02); "
                    "Yahoo's GOLD is A-Mark/Gold.com (listed 2014). No free Randgold series."},
    "VIP": {"reject": ("yahoo", "shared-qlib"),
            "why": "Nasdaq-100 member VIP (2013-10..2015-12) was VimpelCom, renamed VEON on 2017-03-31. Neither "
                   "source's VIP is VimpelCom: return corr with Yahoo VEON's history is -0.03 (shared, 1990 days) "
                   "and 0.14 (Yahoo, 4737 days), while shared VEON matches Yahoo VEON at 0.9997. Priced through "
                   "the VIP->VEON rename."},
}


def ret_corr(a: pd.DataFrame | None, b: pd.DataFrame | None):
    """(correlation of daily close-to-close returns, n overlapping days); (None, n) if < MIN_OVERLAP."""
    if a is None or b is None or not len(a) or not len(b):
        return None, 0
    r = pd.concat([a["close"].pct_change(), b["close"].pct_change()], axis=1, join="inner").dropna()
    r = r[(r.abs() < 0.5).all(axis=1)]
    if len(r) < MIN_OVERLAP:
        return None, len(r)
    return float(r.iloc[:, 0].corr(r.iloc[:, 1])), len(r)


def spells(iv: pd.DataFrame, t: str):
    g = iv[iv.ticker == t]
    return list(g[["start", "end"]].itertuples(index=False, name=None))


def member_cover(f, t, iv) -> int:
    if f is None or not len(f):
        return 0
    sp = spells(iv, t)
    if not sp:
        return len(f)  # benchmark / alias target: any data counts
    return int(sum(((f.index >= a) & (f.index <= b)).sum() for a, b in sp))


def member_days(t, iv) -> int:
    return int(sum(len(pd.bdate_range(a, b)) for a, b in spells(iv, t)))


def in_membership(f, t, iv, pad=pd.Timedelta(days=30)):
    """The part of a series inside t's membership spells (a reused symbol's later data is ignored)."""
    if f is None:
        return None
    keep = np.zeros(len(f), bool)
    for a, b in spells(iv, t):
        keep |= (f.index >= a - pad) & (f.index <= b + pad)
    return f[keep]


def _mask(idx, sp):
    """Bars of idx inside the spells sp (all bars when sp is empty: benchmark / alias target)."""
    if not sp:
        return np.ones(len(idx), bool)
    m = np.zeros(len(idx), bool)
    for a, b in sp:
        m |= (idx >= a) & (idx <= b)
    return m


# ---------------------------------------------------------------------------
# 0. series quality (corrupt bars, mis-scaled spans, scale breaks) and company identity
# ---------------------------------------------------------------------------

def _split_like(lr):
    x = float(np.exp(abs(lr)))
    return any(abs(x - r) <= 0.03 * r for r in (2.0, 3.0))


def _confirmer(other):
    """f(date, lr) -> True when the independent series `other` moves the same way, at least half as much,
    within one trading day of date (a real event, not a data error)."""
    if other is None or not len(other):
        return lambda d, lr: False
    c = other["close"]
    olr = np.log(c[c > 0]).diff().dropna()

    def ok(d, lr):
        w = olr[(olr.index >= d - pd.Timedelta(days=4)) & (olr.index <= d + pd.Timedelta(days=4))]
        return bool(((np.sign(w) == np.sign(lr)) & (w.abs() >= 0.5 * abs(lr))).any())
    return ok


def _member_density(f, sp):
    have = want = 0
    for a, b in (sp or [(f.index[0], f.index[-1])]):
        lo, hi = max(a, f.index[0]), min(b, f.index[-1])
        if hi < lo:
            continue
        want += len(pd.bdate_range(lo, hi))
        have += int(((f.index >= lo) & (f.index <= hi)).sum())
    return (have / want if want else None), want


def clean_series(f, sp=None, confirm=None):
    """Detect and remove corrupt data in one OHLCV series (rules in the module docstring).
    sp: membership spells [(start, end)] (empty -> every bar counts); confirm: an independent series of
    (possibly) the same security, used only to recognise real jumps.
    Returns (cleaned frame, or None if rejected, report). report["rejected"] is the reason or None;
    report["_dropped"] holds the dates removed (internal, for refilling)."""
    rep = {"bad_bars": 0, "stale_bars": 0, "fixed_fields": 0, "spikes": [], "breaks": [], "crashes": [],
           "excluded": [], "dropped_member_bars": 0, "rejected": None, "_dropped": pd.DatetimeIndex([])}
    if f is None or not len(f):
        return f, rep
    orig = f
    f = f[~f.index.duplicated()].sort_index().copy()
    c = f["close"].astype(float).values
    bad = ~np.isfinite(c) | (c <= 0)
    rep["bad_bars"] = int(bad.sum())
    f = f[~bad]
    if not len(f):
        rep["rejected"] = "no positive prices"
        return None, rep
    for k in ("open", "high", "low"):
        if k not in f:
            continue
        v = f[k].astype(float)
        with np.errstate(divide="ignore", invalid="ignore"):
            off = np.abs(np.log(v / f["close"])) > np.log(4)
        badk = (v <= 0) | off  # NaN stays NaN (the engine treats a missing open as unpriced)
        if badk.any():
            f.loc[badk, k] = f.loc[badk, "close"]
            rep["fixed_fields"] += int(badk.sum())
    if "volume" in f:
        same = np.ones(len(f), bool)
        prev = f["close"].shift()
        for k in ("open", "high", "low", "close"):
            if k in f:
                same &= (f[k] == prev).values
        stale = (f["volume"].fillna(0) == 0).values & same
        rep["stale_bars"] = int(stale.sum())
        f = f[~stale]
    member0 = int(_mask(f.index, sp).sum())
    confirmed = _confirmer(confirm)
    dropped = pd.DatetimeIndex([])

    def drop(i, j, lr):  # drop bars at positions i..j-1
        nonlocal f, dropped
        idx = f.index[i:j]
        rep["spikes"].append({"from": str(idx[0].date()), "to": str(idx[-1].date()), "bars": int(len(idx)),
                              "factor": round(float(np.exp(lr)), 4)})
        dropped = dropped.append(idx)
        f = f.drop(idx)

    while len(f) > 2:  # innermost mis-scaled span first, until none is left
        lc = np.log(f["close"].values.astype(float))
        lr = np.diff(lc)
        J = np.where(np.abs(lr) >= QUICK)[0] + 1  # bar positions reached by a jump
        found = None
        for a, i in enumerate(J):
            li = lr[i - 1]
            big_i, sl_i = abs(li) >= SPIKE, abs(li) >= SPLIT_LIKE and _split_like(li)
            if confirmed(f.index[i], li):
                continue
            for j in J[a + 1:]:
                if j - i > SPIKE_MAX_BARS:
                    break
                lj = lr[j - 1]
                if np.sign(lj) == np.sign(li):
                    continue
                if not ((big_i and abs(lj) >= SPIKE) or (sl_i and abs(lj) >= SPLIT_LIKE and _split_like(lj))
                        or j - i <= QUICK_BARS):
                    continue
                if abs(lc[j] - lc[i - 1]) <= 0.3 * abs(li) and not confirmed(f.index[j], lj):
                    found = (i, j, li)
                    break
            if found:
                break
        if not found:
            break
        drop(*found)

    # edge spikes: a big jump right next to either end, with nothing after it to undo it
    for _ in range(4):
        if len(f) <= 2 * EDGE_BARS:
            break
        lr = np.diff(np.log(f["close"].values.astype(float)))
        J = [i for i in np.where(np.abs(lr) >= SPIKE)[0] + 1 if not confirmed(f.index[i], lr[i - 1])]
        head = [i for i in J if i <= EDGE_BARS]
        tail = [i for i in J if i >= len(f) - EDGE_BARS]
        if head:
            drop(0, head[-1], -lr[head[-1] - 1])
        elif tail:
            drop(tail[0], len(f), lr[tail[0] - 1])
        else:
            break

    spike_member = int(_mask(dropped, sp).sum()) if len(dropped) else 0
    if len(f) > 1:
        lr = pd.Series(np.diff(np.log(f["close"].values.astype(float))), index=f.index[1:])
        for d, v in lr[lr >= BREAK_UP].items():
            if not confirmed(d, v):
                rep["breaks"].append({"date": str(d.date()), "factor": round(float(np.exp(v)), 4)})
        for d, v in lr[lr <= CRASH].items():
            if not confirmed(d, v):
                rep["crashes"].append({"date": str(d.date()), "factor": round(float(np.exp(v)), 4)})
    rep["_dropped"] = dropped
    if len(rep["breaks"]) > 2:
        rep["rejected"] = f"{len(rep['breaks'])} scale breaks (unreversed one-day rises of more than +300%)"
        return None, rep
    if rep["breaks"]:
        cuts = [f.index.get_loc(pd.Timestamp(b["date"])) for b in rep["breaks"]]
        bounds = [0] + cuts + [len(f)]
        segs = [(bounds[k], bounds[k + 1]) for k in range(len(bounds) - 1)]
        score = [(int(_mask(f.index[a:b], sp).sum()), b - a) for a, b in segs]
        keep = segs[max(range(len(segs)), key=lambda k: score[k])]
        for a, b in segs:
            if (a, b) != keep:
                idx = f.index[a:b]
                rep["excluded"].append({"from": str(idx[0].date()), "to": str(idx[-1].date()), "bars": int(len(idx))})
                dropped = dropped.append(idx)
        f = f.iloc[keep[0]:keep[1]]
        rep["_dropped"] = dropped
    rep["dropped_member_bars"] = int(_mask(dropped, sp).sum()) if len(dropped) else 0
    if member0 and spike_member > MAX_DROP_SHARE * member0:
        rep["rejected"] = f"{spike_member} of {member0} membership bars mis-scaled"
        return None, rep
    if not len(f):
        rep["rejected"] = "nothing left after cleaning"
        return None, rep
    dens, want = _member_density(f, sp)
    if dens is not None and want >= 20 and dens < MIN_DENSITY:
        rep["rejected"] = f"bars on only {dens:.0%} of membership trading days"
        return None, rep
    untouched = len(f) == len(orig) and not rep["fixed_fields"] and f.index.equals(orig.index)
    return (orig if untouched else f), rep


def quality_summary(rep):
    """Compact, JSON-friendly record of what clean_series found (None when nothing)."""
    if not rep:
        return None
    out = {k: v for k, v in rep.items() if not k.startswith("_") and v not in (0, [], None)}
    return out or None


def market_proxy(frames: dict, min_names=20):
    """Equal-weight market: the median daily return across the given series (|r| < 50%), on days with at
    least min_names series. None when too few series (unit tests, tiny universes)."""
    cols = {t: f["close"].pct_change() for t, f in frames.items() if f is not None and len(f) > 1}
    if len(cols) < min_names:
        return None
    R = pd.DataFrame(cols)
    R = R.where(R.abs() < 0.5)
    m = R.median(axis=1)[R.notna().sum(axis=1) >= min_names]
    return m if len(m) else None


def _mkt_corr(f, mkt):
    if mkt is None or f is None or len(f) < 2:
        return None, 0
    j = pd.concat([f["close"].pct_change(), mkt], axis=1, join="inner").dropna()
    j = j[(j.abs() < 0.5).all(axis=1)]
    if len(j) < MIN_OVERLAP:
        return None, len(j)
    return float(j.iloc[:, 0].corr(j.iloc[:, 1])), len(j)


def identity_issue(f, sp, src, data_start=None, mkt=None):
    """Reason the series f (from source src) cannot be the index member during its membership, or None."""
    if f is None or not len(f) or not sp:
        return None
    fm = f[_mask(f.index, sp)]
    if len(fm) < 5:
        return None
    dv = None
    if "volume" in fm:
        if src == "yahoo" and not float(fm["volume"].median()) > 0:
            return "no trading volume on most membership days"
        dv = float((fm["close"] * fm["volume"]).median())
        if dv < MIN_DOLLAR_VOL:
            return (f"median dollar volume ${dv / 1e6:.2f}M/day during the membership: far too illiquid for an "
                    "index member (a different, smaller company uses the symbol)")
    if data_start is not None and dv is not None and dv < LATE_DOLLAR_VOL:
        first = f.index[0]
        for a, b in sp:
            if first > max(a, data_start) + pd.offsets.BDay(LATE_BDAYS) and first <= b:
                return (f"starts {first:%Y-%m-%d}, in the middle of the {a:%Y-%m-%d}..{b:%Y-%m-%d} membership, and "
                        f"trades only ${dv / 1e6:.1f}M/day: a security listed later than the member")
    c, n = _mkt_corr(fm, mkt)
    if c is not None and n >= MKT_MIN_DAYS and c < MIN_MKT_CORR:
        return (f"daily returns correlate only {c:.2f} with the market over {n} membership days: not a listed "
                "large company")
    return None


def yahoo_identity(y, sp):
    """Liquidity check of a Yahoo series (kept for callers of the earlier API)."""
    return identity_issue(y, sp, "yahoo")


def acquired_end(iv, t):
    """End of t's last spell that closed because the company was acquired (end_note), or None."""
    if "end_note" not in iv:
        return None
    g = iv[(iv.ticker == t) & (iv.end_note.fillna("").astype(str).str.lower() == "acquired")]
    return g.end.max() if len(g) else None


def after_acquisition(f, end, sp, mkt):
    """A series still trading after its member was acquired on `end` -> (frame or None, note or None).
    Same kind of normally traded security before and after (market corr >= CONTINUITY_CORR on both
    sides): a later owner's whole history under the recycled symbol, so nothing up to the acquisition is
    the member's. Otherwise the bars after the acquisition belong to another security and are cut.
    Bars are kept after the acquisition only when the symbol has a later membership spell (re-used by a
    company that joined the index later, e.g. CEG, DELL, SNDK)."""
    if f is None or end is None:
        return f, None
    post = f[f.index > end + ACQ_GRACE]
    if len(post) < 20:
        return f, None
    later = any(b > end + ACQ_GRACE for _, b in sp)  # the symbol is a member again (or still) later
    pre = f[f.index <= end]  # the last member day; the acquired shares stop trading there
    cpre, _ = _mkt_corr(pre.iloc[-MKT_MIN_DAYS:], mkt)
    cpost, _ = _mkt_corr(post.iloc[:MKT_MIN_DAYS], mkt)
    if len(pre) and cpre is not None and cpost is not None and min(cpre, cpost) >= CONTINUITY_CORR:
        note = (f"trades as the same kind of security for {len(post)} bars after the member was acquired "
                f"({end:%Y-%m-%d}; market corr {cpre:.2f} before, {cpost:.2f} after): a later owner's whole "
                "history under the recycled symbol; nothing up to the acquisition is the member's")
        return (post if later else None), note
    if later:
        return f, None
    if not len(pre):
        return None, f"all bars come after the acquisition ({end:%Y-%m-%d}): another company on the symbol"
    # the store may switch to the other security a few bars before the removal date: trim a big final jump
    lr = np.diff(np.log(pre["close"].values.astype(float)))
    tail = [i + 1 for i in np.where(np.abs(lr) >= SPIKE)[0] if i + 1 >= len(pre) - EDGE_BARS]
    if tail:
        pre = pre.iloc[:tail[0]]
    return pre, f"{len(f) - len(pre)} bars from the acquisition ({end:%Y-%m-%d}) on belong to another security; cut"


def _ratio_at(base, other, near, n=40):
    """Scale factor other->base from the n common closes nearest to `near`; None if unstable (CV > 3%)."""
    common = base.index.intersection(other.index)
    if len(common) < 20:
        return None
    pick = common[np.argsort(np.abs(np.asarray((common - near).days)))[:n]]
    r = (base["close"].reindex(pick) / other["close"].reindex(pick)).dropna()
    r = r[np.isfinite(r) & (r > 0)]
    if len(r) < 20 or r.std() / r.mean() > 0.03:
        return None
    return float(r.median())


def _scaled(other, dates, ratio):
    x = other.loc[dates].copy()
    for k in ("open", "high", "low", "close", "vwap"):
        if k in x:
            x[k] = x[k] * ratio
    if "volume" in x:
        x["volume"] = x["volume"] / ratio
    return x


def merge_same(base, other, holes=None):
    """Extend `base` with bars of `other` (the same security, verified by the caller) before base's first
    and after its last bar, and refill `holes` (dates cleaning removed from base), each piece scaled to
    base next to its junction. Returns (merged, info) with the bars added per kind ({} if none)."""
    info, parts = {}, [base]
    before = other.index[other.index < base.index[0]]
    after = other.index[other.index > base.index[-1]]
    for name, dates, near in (("before", before, base.index[0]), ("after", after, base.index[-1])):
        if len(dates):
            r = _ratio_at(base, other, near)
            if r is not None:
                parts.append(_scaled(other, dates, r))
                info[name] = int(len(dates))
    if holes is not None and len(holes):
        h = pd.DatetimeIndex(holes)
        h = h[(h > base.index[0]) & (h < base.index[-1])].intersection(other.index).difference(base.index)
        if len(h):
            r = _ratio_at(base, other, h[len(h) // 2])
            if r is not None:
                parts.append(_scaled(other, h, r))
                info["repaired"] = int(len(h))
    if len(parts) == 1:
        return base, info
    return pd.concat(parts).sort_index(), info


# ---------------------------------------------------------------------------
# 1. date alignment of the shared store
# ---------------------------------------------------------------------------

def align_shared(names, read, yahoo: dict, orig_end, cached: dict | None = None, shifts=(-1, 0, 1)):
    """read(t, k) -> shared OHLCV for t moved k calendar slots later (or None).
    Returns (frames, provenance, consensus, votes)."""
    cached = cached or {}
    orig_end = pd.Timestamp(orig_end)
    measured, group_of, corr_of = {}, {}, {}
    votes = {"extended": [], "original": []}
    for t in names:
        f0 = read(t, 0)
        if f0 is None or not len(f0):
            continue
        group_of[t] = "extended" if f0.index.max() > orig_end else "original"
        if t in yahoo:
            cs = {k: ret_corr(read(t, k), yahoo[t])[0] for k in shifts}
            cs = {k: v for k, v in cs.items() if v is not None}
            if cs and max(cs.values()) > SHIFT_OK:
                k = max(cs, key=cs.get)
                measured[t], corr_of[t] = k, cs[k]
                votes[group_of[t]].append(k)
    consensus = {g: (int(pd.Series(v).mode()[0]) if v else int(cached.get(g, 0))) for g, v in votes.items()}
    frames, prov = {}, {}
    for t, g in group_of.items():
        if t in measured:
            k, basis = measured[t], "measured"
        else:
            k = consensus[g]
            basis = "inferred from group consensus" if votes[g] else "inferred from cached/default calibration"
        f = read(t, k)
        if f is not None and len(f):
            frames[t] = f
            prov[t] = {"shift": int(k), "basis": basis, "group": g, "corr": corr_of.get(t)}
    return frames, prov, consensus, votes


# ---------------------------------------------------------------------------
# 2. source choice
# ---------------------------------------------------------------------------

def choose_sources(names, yahoo: dict, shared: dict, iv: pd.DataFrame, overrides=None, mkt=None):
    """Clean both candidate series, drop the ones that fail the identity checks, then choose (rules in the
    module docstring). Every name with any candidate gets a provenance entry; a name whose candidates all
    fail gets {"source": "none"} and no frame (it counts as unpriced, never as a wrong company).
    mkt: equal-weight market returns (default: built from the Yahoo series passed in)."""
    overrides = IDENTITY_OVERRIDES if overrides is None else overrides
    mkt = market_proxy(yahoo) if mkt is None else mkt
    starts = [f.index[0] for d in (yahoo, shared) for f in d.values() if f is not None and len(f)]
    data_start = min(starts) if starts else None
    frames, prov = {}, {}
    for t in names:
        sp = spells(iv, t)
        y0, s0 = yahoo.get(t), shared.get(t)
        y0 = y0 if y0 is not None and len(y0) else None
        s0 = s0 if s0 is not None and len(s0) else None
        if y0 is None and s0 is None:
            continue
        cand, qual, rej, notes = {}, {}, {}, {}
        for src, raw, other in (("yahoo", y0, s0), ("shared-qlib", s0, y0)):
            if raw is None:
                continue
            f, q = clean_series(raw, sp, confirm=other)
            qual[src] = q
            if q["rejected"]:
                rej[src] = "corrupt: " + q["rejected"]
            cand[src] = f
        ov = overrides.get(t)
        for src in (ov or {}).get("reject", ()):
            if src in cand:
                rej[src] = "curated identity override: " + ov["why"]
        acq = acquired_end(iv, t)
        for src in list(cand):
            if src in rej:
                continue
            f, note = after_acquisition(cand[src], acq, sp, mkt)
            if f is None:
                rej[src] = "identity: " + note
            elif note:
                notes[src] = note
                cand[src] = f
            why = None if src in rej else identity_issue(cand[src], sp, src, data_start, mkt)
            if why:
                rej[src] = "identity: " + why
        y, s = cand.get("yahoo"), cand.get("shared-qlib")
        c, n = ret_corr(y, s)  # cleaned series; a reused symbol trades differently wherever both exist
        if c is not None and c > MATCH:  # the same security: an identity verdict holds for both
            for a_, b_ in (("yahoo", "shared-qlib"), ("shared-qlib", "yahoo")):
                if a_ in rej and not rej[a_].startswith("corrupt") and b_ not in rej:
                    rej[b_] = (f"identity: same security as the rejected {a_} series "
                               f"(return corr {c:.3f} over {n}d)")
        y = None if "yahoo" in rej else y
        s = None if "shared-qlib" in rej else s
        if y is not None and s is not None and n < MIN_OVERLAP and y.index[0] >= s.index[-1] - pd.Timedelta(days=7) \
                and member_cover(y, t, iv) and member_cover(s, t, iv):
            jump = abs(float(np.log(y["close"].iloc[0] / s["close"].iloc[-1])))
            if jump > JUNCTION_JUMP:
                rej["yahoo"] = (f"identity: starts {y.index[0]:%Y-%m-%d}, where the member's shared history ends "
                                f"({s.index[-1]:%Y-%m-%d}), with a {np.exp(jump):.1f}x level jump (recycled symbol)")
                y = None
        f, p, other = _choose(t, y, s, iv, c, n)
        if f is not None and sp and member_cover(f, t, iv) == 0:
            rej[p["source"]] = "no prices inside the membership"
            f = None
        if f is None:
            prov[t] = {"source": "none", "reason": "no usable price series", "verified": True}
        else:
            if other is not None and c is not None and c > MATCH:
                q = qual.get(p["source"], {})
                f, info = merge_same(f, other, q.get("_dropped"))
                if info:
                    p["merged"] = {"from": "shared-qlib" if p["source"] == "yahoo" else "yahoo", **info}
            frames[t], prov[t] = f, p
        if rej:
            prov[t]["rejected"] = rej
        if notes:
            prov[t]["cut"] = notes
        quality = {k: v for k, v in ((k, quality_summary(q)) for k, q in qual.items()) if v}
        if quality:
            prov[t]["quality"] = quality
    return frames, prov


def _choose(t, y, s, iv, c, n):
    """Source choice between the surviving candidates -> (frame, provenance, the other candidate or None)."""
    if y is not None and s is not None:
        cy, cs = member_cover(y, t, iv), member_cover(s, t, iv)
        if cs > cy:
            return s, {"source": "shared-qlib", "reason": "coverage override", "yahoo_member_days": cy,
                       "shared_member_days": cs, "corr": c, "n": n,
                       "verified": c is not None and c > MATCH}, y
        if c is not None and c < REUSE:
            if cs >= cy:
                return s, {"source": "shared-qlib", "reason": "Yahoo symbol reused by a different security",
                           "corr": c, "n": n, "verified": True}, None
            # The two sources are different securities, but Yahoo's covers more of the membership:
            # the stale shared store holds the symbol's *previous* owner (e.g. COR = CoreSite there,
            # Cencora on Yahoo), so the member is the Yahoo series.
            return y, {"source": "yahoo", "reason": "shared-qlib symbol belongs to an earlier security",
                       "corr": c, "n": n, "yahoo_member_days": cy, "shared_member_days": cs, "verified": True}, None
        return y, {"source": "yahoo", "reason": "default", "verified": True}, s
    if y is not None:
        return y, {"source": "yahoo", "reason": "default", "verified": True}, None
    if s is not None and len(s):
        return s, {"source": "shared-qlib", "reason": "not served by Yahoo", "verified": True}, None
    return None, None, None


# ---------------------------------------------------------------------------
# 3. renames
# ---------------------------------------------------------------------------

def detect_renames(frames: dict, iv: pd.DataFrame, known: dict, today=None):
    """Returns {old: {"to", "basis", "corr", "n"}}; basis 'price-verified' or 'curated'."""
    today = pd.Timestamp(today) if today is not None else pd.Timestamp.today().normalize()
    bdays = pd.bdate_range(iv.start.min(), today)
    starts = iv.groupby("start").ticker.apply(list)
    out = {}
    for x, g in iv.groupby("ticker"):
        last_end = g.end.max()
        if x in frames and frames[x].index.max() >= last_end - pd.Timedelta(days=14):
            continue  # x is priced to the end of its membership: not a disappearance
        nxt = bdays[bdays.searchsorted(last_end, side="right"):][:3]
        xm = in_membership(frames.get(x), x, iv)
        for y in [y for d in nxt for y in starts.get(d, [])]:
            if y == x or y not in frames or xm is None or not len(xm):
                continue
            c, n = ret_corr(xm, frames[y])
            if c is not None and c > MATCH:
                out[x] = {"to": y, "basis": "price-verified", "corr": c, "n": n}
                break
    for x, spec in known.items():
        y = spec[0] if isinstance(spec, (tuple, list)) else spec
        if x in out or x not in set(iv.ticker) or y not in frames:
            continue
        if member_cover(frames.get(x), x, iv) >= 0.5 * member_days(x, iv):
            continue  # already priced for most of its membership
        xm = in_membership(frames.get(x), x, iv)
        c, n = ret_corr(xm, frames[y]) if xm is not None and len(xm) else (None, 0)
        if c is not None and c < MATCH:
            continue  # contradicted by prices: do not apply
        out[x] = {"to": y, "basis": "price-verified" if c is not None else "curated", "corr": c, "n": n}
    return out


def uncertain_corrections(align_prov: dict, source_prov: dict, renames: dict, used) -> list:
    """Corrections applied without direct price evidence, judged on the series each used name
    actually ends up with (a renamed name uses its successor's series)."""
    out = []
    for t in sorted(set(used)):
        r = renames.get(t)
        eff = r["to"] if r else t
        p = source_prov.get(eff, {})
        if r and r["basis"] == "curated":
            out.append({"ticker": t, "kind": "curated rename", "detail": f"{t}->{eff} from the known-renames list; not price-verified"})
        if not r and p.get("reason") == "coverage override" and not p.get("verified"):
            out.append({"ticker": t, "kind": "source chosen by coverage only",
                        "detail": f"shared series covers {p['shared_member_days']} member-days vs Yahoo "
                                  f"{p['yahoo_member_days']}; no overlapping prices to confirm identity"})
        a = align_prov.get(eff)
        if p.get("source") == "shared-qlib" and a and a["basis"] != "measured":
            kind = "inferred date shift" if a["shift"] != 0 else "unmeasured date alignment"
            out.append({"ticker": t, "kind": kind,
                        "detail": f"shared series of {eff} used with shift {a['shift']:+d} ({a['basis']}); not measured for this ticker"})
    return out


# ---------------------------------------------------------------------------
# 4. member price coverage (eligibility = member AND priced)
# ---------------------------------------------------------------------------

def member_price_coverage(member: pd.DataFrame, priced: pd.DataFrame, iv: pd.DataFrame):
    """Returns (eligible, never_priced {t: [spells]}, partly_priced {t: share}, overall share of member-days priced)."""
    priced = priced.reindex(index=member.index, columns=member.columns, fill_value=False)
    eligible = member & priced
    mem_days, ok_days = member.sum(), eligible.sum()
    never = {t: [f"{a:%Y-%m-%d}..{b:%Y-%m-%d}" for a, b in spells(iv, t)]
             for t in member.columns if mem_days[t] > 0 and ok_days[t] == 0}
    partly = {t: round(float(ok_days[t] / mem_days[t]), 3) for t in member.columns
              if mem_days[t] > 0 and 0 < ok_days[t] < 0.95 * mem_days[t]}
    overall = float(eligible.values.sum() / max(member.values.sum(), 1))
    return eligible, never, partly, overall


# ---------------------------------------------------------------------------
# 5. where a series ends: listed, delisted, or a data gap at a source cutoff
# ---------------------------------------------------------------------------

def store_cutoffs(ends, min_share=0.01, min_count=25):
    """Dates on which a large share of a store's series end together: the store stopped being updated
    (Qlib's US data ends 2020-11-10 for most names), not the stocks."""
    ends = pd.Series(pd.to_datetime(list(ends)))
    if not len(ends):
        return []
    n = ends.value_counts()
    return sorted(n[n >= max(min_count, min_share * len(ends))].index)


def end_kind(last, cal_end, cutoffs=(), tol_days=5):
    """'listed' (runs to the calendar end), 'gap' (stops within tol_days of a source cutoff: the data
    source ended, the stock did not) or 'delisted'. Only a 'delisted' end may become a delisting date."""
    last, cal_end = pd.Timestamp(last), pd.Timestamp(cal_end)
    if last >= cal_end - pd.Timedelta(days=10):
        return "listed"
    if any(abs((last - pd.Timestamp(c)).days) <= tol_days for c in cutoffs):
        return "gap"
    return "delisted"


def member_gaps_by_year(member: pd.DataFrame, eligible: pd.DataFrame, gap_after: dict | None = None):
    """Member-days without prices per year. gap_after {ticker: last priced day} for names whose series
    stops at a source cutoff; their unpriced member-days after that day are counted as 'after_cutoff'.
    Returns rows {year, member_days, unpriced, share, after_cutoff, never_priced, other}."""
    eligible = eligible.reindex(index=member.index, columns=member.columns, fill_value=False).astype(bool)
    member = member.astype(bool)
    un = member & ~eligible
    never = [t for t in member.columns if member[t].any() and not eligible[t].any()]
    cut = pd.DataFrame(False, index=member.index, columns=member.columns)
    for t, d in (gap_after or {}).items():
        if t in cut.columns:
            cut[t] = member.index > pd.Timestamp(d)
    rows = []
    for y, idx in member.groupby(member.index.year).groups.items():
        m, u = member.loc[idx], un.loc[idx]
        md, ud = int(m.values.sum()), int(u.values.sum())
        a = int((u & cut.loc[idx]).values.sum())
        nv = int(u[never].values.sum()) if never else 0
        rows.append({"year": int(y), "member_days": md, "unpriced": ud, "share": round(ud / md, 4) if md else 0.0,
                     "after_cutoff": a, "never_priced": nv, "other": ud - a - nv})
    return rows
