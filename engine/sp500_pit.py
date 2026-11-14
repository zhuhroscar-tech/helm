"""Rebuild the S&P 500 point-in-time membership file that Helm passes to the qlib research engine (engine/qlib_research).

    python3 engine/sp500_pit.py            # with the qlib Python (run.sh --which-python)

Base: Qlib's sp500.txt, point-in-time up to 2020-10-12. After that, every change in Wikipedia's
"Historical components of the S&P 500" table is applied in date order (addition = member from the
effective date; removal = last member day is the business day before). Same-company ticker changes
use today's symbol for the whole history, because Yahoo keeps the history under it.

The result must reproduce Wikipedia's current constituent list exactly; otherwise nothing is written
and the differences are printed (usually a new ticker change to add to ALIAS).

Output: ~/.qlib/qs_cache/membership/sp500_pit.txt (TICKER<TAB>start<TAB>end[<TAB>acquired]) + .json
provenance. Membership dates come from Wikipedia and are not price-verified.

A spell gets the fourth column "acquired" when Wikipedia's change table removed the name because the
company was acquired (the reason names the removed company as the one bought). Its own shares stopped
trading then, so the research engine (qs_data) can tell a later owner's history under a recycled symbol
from the member's own prices.
"""
import hashlib
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import pandas as pd
import requests
from pandas.tseries.offsets import BDay

BASE = Path(os.path.expanduser("~/.qlib/qlib_data/us_data/instruments/sp500.txt"))
OUT = Path(os.environ.get("HELM_SP500_PIT", os.path.expanduser("~/.qlib/qs_cache/membership/sp500_pit.txt")))
BASE_END = pd.Timestamp("2020-10-12")  # last change already recorded in Qlib's file
UA = {"User-Agent": "HelmConsole/1.0 (personal research tool)"}
CURRENT_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
CHANGES_URL = "https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_500"

# Same company, new symbol (old -> current). Verified 2026-11-08: Wikipedia's "date added" for the new
# symbol equals the old company's, and Yahoo serves the full history under the new symbol.
ALIAS = {"ABC": "COR", "ANTM": "ELV", "BK": "BNY", "BLL": "BALL", "EQR": "VMRK", "FB": "META", "FLT": "CPAY",
         "LB": "BBWI", "MMC": "MRSH", "MYL": "VTRS", "NLOK": "GEN", "PEAK": "DOC", "PKI": "RVTY", "RE": "EG",
         "SATS": "ECHO", "VIAC": "SKYD", "WRK": "SW", "COG": "CTRA"}
# Kept as two symbols: Yahoo has no Coterra history and the stale store's CTRA is a different company.
# WRK/SW: Smurfit Westrock (added 2024-07-08 per Wikipedia's constituent list) is not WestRock's history:
# Yahoo's SW before July 2024 is Smurfit Kappa's foreign listing (flat prices, no volume).
SPLIT = {"CTRA": ("COG", "2021-10-04"), "SW": ("WRK", "2024-07-08")}
ACQ_WORDS = r"(?:acquired|bought|purchased|taken private|acquisition of|buyout of)"
GENERIC = {"the", "inc", "corp", "corporation", "company", "co", "group", "holdings", "international", "plc", "ltd"}
PREEXISTING_OVERLAPS = {"AGN", "CB", "DD", "JCI"}  # symbol reuse already present in Qlib's file
OPEN = pd.Timestamp("2099-12-31")


def norm(x):
    return None if pd.isna(x) else str(x).strip().upper().replace(".", "-")


def canon(t):
    return ALIAS.get(t, t) if t else t


def name_tokens(ticker, name):
    """Words that identify the removed company in a reason text: its ticker and the first distinctive word
    of its name (a word with a digit, like L3, counts from two characters)."""
    toks = {ticker} if ticker else set()
    for w in re.findall(r"[A-Za-z0-9][A-Za-z0-9&'-]*", str(name or "")):
        w = w.split("-")[0]
        if (len(w) >= 3 or (len(w) == 2 and any(ch.isdigit() for ch in w))) and w.lower() not in GENERIC:
            toks.add(w)
            break
    return toks


def was_acquired(ticker, name, reason):
    """True when the reason says the removed company itself was bought ("X acquired <it>", "<it> was acquired")."""
    r = str(reason or "").strip()
    if re.fullmatch(r"acquired\.?", r, re.I):
        return True
    for tok in name_tokens(ticker, name):
        t = re.escape(tok[:-1] if len(tok) > 4 and tok.lower().endswith("s") else tok) + r"\w*"
        if re.search(ACQ_WORDS + r"\s+(?:\(?the\)?\s+|[\w.&'-]+\s+){0,3}?" + t + r"\b", r, re.I) \
                or re.search(r"\b" + t + r"\b[^.;]{0,40}?\b(?:was|were|is|has been|being)\s+(?:acquired|bought|purchased|taken private)", r, re.I):
            return True
    return False


def fetch(url):
    r = requests.get(url, headers=UA, timeout=60)
    r.raise_for_status()
    return pd.read_html(io.StringIO(r.text))[0]


def main():
    cur = fetch(CURRENT_URL)
    time.sleep(3)
    ch = fetch(CHANGES_URL)
    ch.columns = ["date", "add", "add_name", "rem", "rem_name", "reason", "refs"]
    ch["date"] = pd.to_datetime(ch["date"], errors="coerce")
    acquired = [(canon(norm(r.rem)), r.date) for r in ch.itertuples()
                if norm(r.rem) and pd.notna(r.date) and was_acquired(norm(r.rem), r.rem_name, r.reason)]
    ch = ch[ch.date > BASE_END].sort_values("date", kind="stable")

    q = pd.read_csv(BASE, sep="\t", header=None, names=["t", "s", "e"], dtype=str)
    spells = [dict(t=canon(norm(r.t)), s=pd.Timestamp(r.s.strip()), e=pd.Timestamp(r.e.strip())) for r in q.itertuples()]
    unresolved, n_add, n_rem = [], 0, 0
    for r in ch.itertuples():
        d, rem, add = r.date, canon(norm(r.rem)), canon(norm(r.add))
        if rem:
            sp = [x for x in spells if x["t"] == rem and x["e"] == OPEN]
            if sp:
                sp[0]["e"] = d - BDay(1)
                n_rem += 1
            else:
                unresolved.append(("remove", str(d.date()), rem, r.rem_name))
        if add:
            if any(x["t"] == add and x["e"] == OPEN for x in spells):
                unresolved.append(("add-already-member", str(d.date()), add, r.add_name))
            else:
                spells.append(dict(t=add, s=d, e=OPEN))
                n_add += 1
    out = []
    for x in spells:
        if x["t"] in SPLIT:
            old, d = SPLIT[x["t"]][0], pd.Timestamp(SPLIT[x["t"]][1])
            if x["s"] < d <= x["e"]:
                out += [dict(t=old, s=x["s"], e=d - BDay(1)), dict(t=x["t"], s=d, e=x["e"])]
                continue
        out.append(x)

    df = pd.DataFrame(out).sort_values(["t", "s"]).reset_index(drop=True)
    # removal for an acquisition: Wikipedia's effective date is the business day after the last member day
    df["note"] = [("acquired" if r.e != OPEN and any(t == r.t and abs((d - (r.e + BDay(1))).days) <= 7 for t, d in acquired)
                   else "") for r in df.itertuples()]
    overlaps = {t for t, g in df.groupby("t") if (g.s.values[1:] <= g.e.values[:-1]).any()}
    bad = df[df.e < df.s]
    now = {x["t"] for x in out if x["e"] == OPEN}
    today = set(cur["Symbol"].map(norm))
    problems = []
    if unresolved:
        problems.append(f"unresolved changes: {unresolved}")
    if len(bad):
        problems.append(f"spells ending before they start: {bad.t.tolist()}")
    if overlaps - PREEXISTING_OVERLAPS:
        problems.append(f"new overlapping spells: {sorted(overlaps - PREEXISTING_OVERLAPS)}")
    if now != today:
        problems.append(f"reconstruction minus current: {sorted(now - today)}; current minus reconstruction: "
                        f"{sorted(today - now)} (a new ticker change? add it to ALIAS)")
    if problems:
        print("NOT WRITTEN:\n  " + "\n  ".join(problems))
        return 1

    txt = "".join(f"{r.t}\t{r.s.date()}\t{r.e.date()}" + (f"\t{r.note}" if r.note else "") + "\n" for r in df.itertuples())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(txt)
    prov = {
        "built": str(pd.Timestamp.today().date()), "as_of": str(ch.date.max().date()), "spells": len(df),
        "tickers_ever": int(df.t.nunique()), "members_today": len(now),
        "base": f"Qlib sp500.txt (point-in-time to {BASE_END.date()})",
        "changes": f'Wikipedia "Historical components of the S&P 500", {len(ch)} rows after {BASE_END.date()} '
                   f"({n_add} additions, {n_rem} removals)",
        "cross_check": f"reconstructed members equal the current Wikipedia constituent list exactly ({len(today)} names)",
        "ticker_changes": "same-company changes use the current symbol for the whole history: "
                          + ", ".join(f"{k}->{v}" for k, v in ALIAS.items() if k not in {v2[0] for v2 in SPLIT.values()}),
        "split": "COG until 2021-10-01, CTRA from 2021-10-04 (approximate change date; no Coterra prices after 2020-11); "
                 "WRK until 2024-07-05, SW from 2024-07-08 (Smurfit Westrock's date added; Yahoo's earlier SW is Smurfit Kappa)",
        "acquired_spells": f"{int((df.note == 'acquired').sum())} spells end with an acquisition per Wikipedia's reason "
                           "column (fourth column 'acquired'); used to reject a later owner's history under a recycled symbol",
        "preexisting_overlaps": ", ".join(sorted(PREEXISTING_OVERLAPS)) + " have overlapping spells in Qlib's file (kept)",
        "not_verified": "membership dates come from Wikipedia and are not price-verified",
        "sha256": hashlib.sha256(txt.encode()).hexdigest(),
    }
    OUT.with_suffix(".json").write_text(json.dumps(prov, indent=1, ensure_ascii=False))
    print(json.dumps(prov, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
