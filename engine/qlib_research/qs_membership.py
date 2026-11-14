"""Index membership for the quant-strategy engine: point-in-time when a source exists,
otherwise an explicitly labelled snapshot.

Sources, best first
  1. user file (--membership-file): lines "TICKER<TAB>start<TAB>end[<TAB>end_note]" (repeat a ticker
     for several spells). Treated as point-in-time; the user vouches for it. The optional end_note
     says why the spell ended; "acquired" (the company was bought, so its own shares stopped trading)
     lets qs_data recognise a later owner's history under a recycled symbol.
  2. Nasdaq-100 (QQQ / NDX / nasdaq100): Nasdaq's index-weighting endpoint, the source Qlib's
     own collector uses. Sampled at the first trading day of each month, then every change is
     located to the exact day by bisection. Cached per date in ~/.qlib/qs_cache/membership/.
  3. Qlib instrument file with real intervals (e.g. sp500.txt, nasdaq100.txt shipped with Qlib's
     US data): point-in-time up to the file's as-of date, frozen afterwards ("partial").
  4. Snapshot list (instrument file without history, or --tickers): every name is assumed a
     member for the whole period. Survivorship bias is NOT removed and the report says so.

Returned object: {"kind": "point-in-time" | "partial-point-in-time" | "snapshot",
 "intervals": DataFrame[ticker, start, end(, end_note)], "as_of", "source", "notes"}.
"""
from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

CACHE = Path(os.path.expanduser("~/.qlib/qs_cache/membership"))
NDX_URL = ("https://indexes.nasdaqomx.com/Index/WeightingData?id=NDX&tradeDate={d}T00%3A00%3A00.000"
           "&timeOfDay=SOD")
NDX_KEYS = {"qqq", "ndx", "nasdaq100", "nasdaq"}


# ---------------------------------------------------------------------------
# Nasdaq-100 from the official endpoint
# ---------------------------------------------------------------------------

def _ndx_fetch(d: pd.Timestamp):
    """Members on date d (None if the endpoint has no data for d, e.g. a holiday)."""
    import requests
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"NDX_{d:%Y-%m-%d}.json"
    if f.exists():
        v = json.loads(f.read_text())
        return None if v is None else set(v)
    for attempt in range(3):
        try:
            r = requests.post(NDX_URL.format(d=f"{d:%Y-%m-%d}"), timeout=30)
            r.raise_for_status()
            rows = r.json().get("aaData", [])
            v = sorted({x["Symbol"].strip().upper().replace(".", "-") for x in rows}) or None
            f.write_text(json.dumps(v))
            return None if v is None else set(v)
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise


def _ndx_on_or_after(days: pd.DatetimeIndex, i: int):
    """First business day at or after position i with data -> (pos, members)."""
    while i < len(days):
        m = _ndx_fetch(days[i])
        if m is not None:
            return i, m
        i += 1
    return None, None


def ndx_history(start, end, log=print) -> pd.DataFrame:
    days = pd.bdate_range(pd.Timestamp(start), pd.Timestamp(end))
    month_pos = sorted({int(days.searchsorted(pd.Timestamp(y, m, 1)))
                        for y in range(days[0].year, days[-1].year + 1) for m in range(1, 13)
                        if days[0] <= pd.Timestamp(y, m, 1) <= days[-1]} | {0})
    with ThreadPoolExecutor(max_workers=8) as ex:
        samples = list(ex.map(lambda i: _ndx_on_or_after(days, i), month_pos))
    samples = [(p, m) for p, m in samples if p is not None]
    for i in range(len(days) - 1, max(len(days) - 8, -1), -1):  # also sample the last available day
        m = _ndx_fetch(days[i])
        if m is not None:
            samples.append((i, m))
            break
    samples = sorted({p: m for p, m in samples}.items())
    # daily membership table on sample days; locate each change between samples by bisection
    events = []  # (pos, ticker, +1/-1)
    def first_pos_where(lo, hi, pred):
        # smallest valid position in (lo, hi] where pred(members) is True; members(hi) satisfies pred
        while hi - lo > 1:
            mid = (lo + hi) // 2
            p, m = _ndx_on_or_after(days, mid)
            if p is None or p >= hi:
                return hi
            if pred(m):
                hi = p
            else:
                lo = p
        return hi
    jobs = []
    for (p0, m0), (p1, m1) in zip(samples, samples[1:]):
        for t in m1 - m0:
            jobs.append((p0, p1, t, +1))
        for t in m0 - m1:
            jobs.append((p0, p1, t, -1))
    def locate(job):
        p0, p1, t, sgn = job
        pred = (lambda m: t in m) if sgn > 0 else (lambda m: t not in m)
        return first_pos_where(p0, p1, pred), t, sgn
    with ThreadPoolExecutor(max_workers=8) as ex:
        events = list(ex.map(locate, jobs))
    log(f"membership: Nasdaq-100 from {len(samples)} monthly samples + {len(events)} located changes")
    # build spells
    cur = {t: days[samples[0][0]] for t in samples[0][1]}
    rows = []
    for pos, t, sgn in sorted(events):
        if sgn > 0:
            cur.setdefault(t, days[pos])
        elif t in cur:
            rows.append((t, cur.pop(t), days[pos - 1]))
    last = days[samples[-1][0]]
    rows += [(t, s, last) for t, s in cur.items()]
    df = pd.DataFrame(rows, columns=["ticker", "start", "end"]).sort_values(["ticker", "start"])
    df.attrs["as_of"] = str(last.date())
    return df.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Generic resolution
# ---------------------------------------------------------------------------

def _read_intervals(path) -> pd.DataFrame:
    rows, notes = [], False
    for ln in Path(path).read_text().splitlines():
        parts = ln.strip().split("\t")
        if len(parts) >= 3:
            note = parts[3].strip() if len(parts) >= 4 else ""
            notes |= bool(note)
            rows.append((parts[0].upper().replace(".", "-"), pd.Timestamp(parts[1]), pd.Timestamp(parts[2]), note))
        elif len(parts) == 1 and parts[0]:
            rows.append((parts[0].upper(), pd.Timestamp("1990-01-01"), pd.Timestamp("2099-12-31"), ""))
    df = pd.DataFrame(rows, columns=["ticker", "start", "end", "end_note"])
    return df if notes else df.drop(columns="end_note")


def last_change(df: pd.DataFrame) -> str | None:
    """Date of the last recorded membership change (latest removal, or latest start after the floor)."""
    ends = df.end[df.end < pd.Timestamp("2099-01-01")]
    dates = [d for d in (ends.max() if len(ends) else None, df.start.max() if len(df) else None) if d is not None and pd.notna(d)]
    return str(max(dates).date()) if dates else None


def _has_history(df: pd.DataFrame) -> bool:
    # Start dates alone are often listing dates; only removals (an end before 2099) or repeated
    # spells prove the file records membership history.
    return bool(df.ticker.duplicated().any() or (df.end < pd.Timestamp("2099-01-01")).any())


def resolve(target_key: str, tickers: str | None, membership_file: str | None, shared_qlib: str,
            start, end, log=print) -> dict:
    notes = []
    if membership_file:
        iv = _read_intervals(membership_file)
        return {"kind": "point-in-time", "intervals": iv, "as_of": last_change(iv),
                "source": f"user membership file {membership_file}", "notes": ["User-supplied; not independently verified."]}
    if tickers:
        tl = [t.strip().upper() for t in tickers.split(",") if t.strip()]
        iv = pd.DataFrame({"ticker": tl, "start": pd.Timestamp(start), "end": pd.Timestamp(end)})
        return {"kind": "snapshot", "intervals": iv, "as_of": None, "source": "user ticker list (--tickers)",
                "notes": ["Snapshot list applied to all history: survivorship bias not removed; names "
                          "that left the index (often after losses) are missing and later additions are "
                          "treated as members before they joined."]}
    if target_key in NDX_KEYS:
        try:
            iv = ndx_history(start, end, log)
            return {"kind": "point-in-time", "intervals": iv, "as_of": iv.attrs["as_of"],
                    "source": "Nasdaq index-weighting endpoint (indexes.nasdaqomx.com), monthly samples + "
                              "day-exact change dates", "notes": []}
        except Exception as e:  # noqa: BLE001
            notes.append(f"Nasdaq membership endpoint failed ({e}); falling back.")
    for name in ([target_key] + (["nasdaq100"] if target_key in NDX_KEYS else [])):
        f = Path(shared_qlib) / "instruments" / f"{name}.txt"
        if f.exists():
            iv = _read_intervals(f)
            if _has_history(iv):
                # The file is point-in-time only up to its last recorded change (an addition or a
                # removal), not up to the price calendar's end: the shipped sp500.txt stops changing
                # in 2020-10 even though the shared price store runs to 2024-12.
                as_of = last_change(iv)
                return {"kind": "partial-point-in-time", "intervals": iv, "as_of": as_of,
                        "source": f"Qlib instrument file {f} (historical intervals)",
                        "notes": notes + [f"Membership is point-in-time only up to {as_of}; after that the "
                                          f"{as_of} members are assumed unchanged (later additions/removals unknown)."]}
            iv["start"], iv["end"] = pd.Timestamp(start), pd.Timestamp(end)
            return {"kind": "snapshot", "intervals": iv, "as_of": None,
                    "source": f"Qlib instrument file {f} (no history; last modified "
                              f"{pd.Timestamp(f.stat().st_mtime, unit='s').date()})",
                    "notes": notes + ["No historical membership available for this target: the list is applied to all "
                                      "history, so survivorship bias is NOT removed. Supply --membership-file to fix."]}
    raise RuntimeError(f"No constituent list for '{target_key}'. Pass --tickers 'A,B,...' (current constituents) "
                       "or --membership-file with historical intervals.")


def member_matrix(intervals: pd.DataFrame, dates: pd.DatetimeIndex, tickers) -> pd.DataFrame:
    m = pd.DataFrame(False, index=dates, columns=list(tickers))
    for t, s, e in intervals[["ticker", "start", "end"]].itertuples(index=False):
        if t in m.columns:
            m.loc[(dates >= s) & (dates <= e), t] = True
    return m


def coverage_by_year(member: pd.DataFrame, priced: pd.DataFrame) -> pd.DataFrame:
    n_mem = member.sum(axis=1)
    n_ok = (member & priced.reindex(index=member.index, columns=member.columns, fill_value=False)).sum(axis=1)
    df = pd.DataFrame({"members": n_mem, "members_with_prices": n_ok})
    g = df.groupby(df.index.year).mean()
    g["coverage"] = g.members_with_prices / g.members
    return g.round(3)


def read_shared_bin(shared_qlib: str, ticker: str, shift: int = 0) -> pd.DataFrame | None:
    """Read OHLCV for one ticker straight from Qlib's binary layout (no qlib.init needed).
    shift=+1 moves every bar one calendar slot later (use when the store is dated one day early)."""
    root = Path(shared_qlib)
    fdir = root / "features" / ticker.lower()
    if not (fdir / "close.day.bin").exists():
        return None
    cal = pd.DatetimeIndex(pd.to_datetime((root / "calendars" / "day.txt").read_text().split()))
    out = {}
    for f in ["open", "high", "low", "close", "volume"]:
        p = fdir / f"{f}.day.bin"
        if not p.exists():
            return None
        a = np.fromfile(p, dtype="<f4")
        s = int(a[0]) + shift
        vals = a[1:]
        lo, hi = max(s, 0), min(s + len(vals), len(cal))
        out[f] = pd.Series(vals[lo - s: hi - s], index=cal[lo:hi])
    df = pd.DataFrame(out).dropna(how="all")
    return df if len(df) else None
