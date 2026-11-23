"""Helpers the research engine needs without qlib (see notes/qlib-swap-plan.md, step 3).

- write_fields / write_instruments / spells_from_mask: write the per-run data directory in Qlib's
  binary layout (plain files; qs_expr reads them back).
- rank_ic_check: daily rank IC computed the way qlib's calc_ic does it (pandas groupby + Spearman),
  used to cross-check qs_idea's vectorised IC.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd


def rank_ic_check(pred: pd.Series, label: pd.Series, min_names: int = 5) -> pd.Series:
    """Daily rank IC as qlib.contrib.eva.alpha.calc_ic computes it (dates with fewer than min_names pairs
    dropped), so the cross-check keeps working when qlib is not installed."""
    df = pd.concat({"p": pred, "l": label}, axis=1).dropna()
    n = df.groupby(level=0).size()
    df = df[df.index.get_level_values(0).isin(n[n >= min_names].index)]
    ric = df.groupby(level=0, group_keys=False).apply(lambda d: d["p"].corr(d["l"], method="spearman"))
    return ric.dropna()


def write_fields(uri, fields: dict):
    """Add daily fields ({name: DataFrame dates x tickers}) to an existing Qlib provider, aligned to
    the span of each ticker's existing close.day.bin (header = start index in the calendar)."""
    uri = Path(uri)
    cal = pd.DatetimeIndex(pd.read_csv(uri / "calendars" / "day.txt", header=None)[0])
    for name, df in fields.items():
        for t in df.columns:
            f = uri / "features" / t.lower() / "close.day.bin"
            if not f.exists():
                continue
            raw = np.fromfile(f, dtype="<f4")
            start_i, n = int(raw[0]), len(raw) - 1
            vals = df[t].reindex(cal[start_i: start_i + n]).astype("float32").values
            np.hstack([[start_i], vals]).astype("<f4").tofile(f.parent / f"{name.lower()}.day.bin")


def write_instruments(uri, market: str, spells: list):
    """Point-in-time universe as a Qlib instruments file: one line per (ticker, start, end) spell."""
    lines = [f"{t.upper()}\t{pd.Timestamp(a):%Y-%m-%d}\t{pd.Timestamp(b):%Y-%m-%d}" for t, a, b in spells]
    (Path(uri) / "instruments" / f"{market}.txt").write_text("\n".join(lines) + "\n")


def spells_from_mask(mask: pd.DataFrame) -> list:
    """(ticker, first, last) for each run of consecutive True days in a dates x tickers mask."""
    out = []
    for t in mask.columns:
        m = mask[t].astype(bool)
        if not m.any():
            continue
        grp = (m != m.shift(fill_value=False)).cumsum()[m]
        for _, g in grp.groupby(grp):
            out.append((t, g.index[0], g.index[-1]))
    return out
