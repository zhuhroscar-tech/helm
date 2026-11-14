"""Point-in-time fundamentals and sectors from SEC EDGAR (free XBRL "company facts" API).

Rules (tested in test_qs_fund.py):
- A reported value is usable from the first trading day strictly AFTER its `filed` date (the
  time of day of a filing is unknown), and only the EARLIEST filing of each period counts, so
  later restatements and comparative re-reporting never leak backwards.
- Flow items (revenue, earnings, cash flow) become trailing-twelve-month values: a 10-K's annual
  value, or the sum of four discrete quarters (quarters are taken directly or derived from the
  year-to-date values that cash-flow statements report).
- Market value comes from the cover-page public float (dollars, so stock splits cannot distort it),
  rolled forward with the adjusted close: mcap_t = float x close_t / close_at_float_date. Float
  excludes insiders and the roll-forward includes dividends; both are disclosed approximations.
- Ticker -> CIK: SEC's current ticker list, the run's ticker renames, then SEC full-text search
  ("symbol <TICKER>" in the company's own filings) for delisted names. Every mapping must pass a
  check: the company filed during the ticker's priced membership and (for searched mappings)
  reported a public float >= $1B there. Searched mappings are flagged as uncertain.
- Sectors: the SEC SIC code (current classification) grouped into 11 GICS-like sectors.

Requests carry the User-Agent SEC requires (a contact string read from
~/.config/quant-strategy/sec_user_agent or $QS_SEC_USER_AGENT). Responses are cached in
~/.qlib/qs_cache/sec/.
"""
from __future__ import annotations

import json
import os
import re
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

SEC_DIR = Path(os.path.expanduser("~/.qlib/qs_cache/sec"))
UA_FILE = Path(os.path.expanduser("~/.config/quant-strategy/sec_user_agent"))

REV = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
       "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueGoodsNet", "RevenuesNetOfInterestExpense"]
NI = ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"]
GP = ["GrossProfit"]
OPI = ["OperatingIncomeLoss"]
CFO = ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]
ASSETS = ["Assets"]
LIAB = ["Liabilities"]
EQUITY = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]

FEATURES = {
    "F_EP": "TTM net income / market value",
    "F_BM": "book equity / market value",
    "F_SP": "TTM revenue / market value",
    "F_CFP": "TTM operating cash flow / market value",
    "F_SIZE": "log market value (public float rolled forward)",
    "F_ROE": "TTM net income / book equity (equity > 0)",
    "F_ROA": "TTM net income / total assets",
    "F_GPA": "TTM gross profit / total assets",
    "F_OPA": "TTM operating income / total assets",
    "F_ACC": "accruals: (TTM net income - TTM operating cash flow) / total assets",
    "F_LEV": "total liabilities / total assets",
    "F_REVG": "TTM revenue growth vs one year earlier",
    "F_NIG": "change in TTM net income vs one year earlier / total assets",
    "F_AG": "total asset growth vs one year earlier",
    "F_SUE": "standardised unexpected earnings: quarterly net income change vs same quarter a year "
             "earlier / std of that change over the last 8 quarters",
}
MAX_AGE = {"flow": 460, "instant": 460, "float": 800}  # days from period end before a value is stale


# ---------------------------------------------------------------------------
# SEC access (throttled, cached)
# ---------------------------------------------------------------------------

def user_agent() -> str:
    ua = os.environ.get("QS_SEC_USER_AGENT") or (UA_FILE.read_text().strip() if UA_FILE.exists() else "")
    if "@" not in ua:
        raise RuntimeError(
            "SEC requires a contact in the User-Agent of every request. Write one line such as "
            f"'my-research name@example.com' to {UA_FILE} (or set QS_SEC_USER_AGENT) and re-run.")
    return ua


class Sec:
    def __init__(self, min_interval=0.15):
        import requests
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": user_agent(), "Accept-Encoding": "gzip, deflate"})
        self.min_interval, self.last, self.n = min_interval, 0.0, 0

    def get_json(self, url, cache: Path | None = None, max_age_days: float | None = None, missing_ok=False):
        if cache is not None and cache.exists():
            age = (time.time() - cache.stat().st_mtime) / 86400
            if max_age_days is None or age <= max_age_days:
                txt = cache.read_text()
                return None if txt == "null" else json.loads(txt)
        for attempt in range(5):
            wait = self.min_interval - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            self.n += 1
            r = self.s.get(url, timeout=60)
            if r.status_code == 404 and missing_ok:
                data = None
                break
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
            break
        else:
            raise RuntimeError(f"SEC request kept failing: {url}")
        if cache is not None:
            cache.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache.with_suffix(".tmp")
            tmp.write_text(json.dumps(data))
            tmp.replace(cache)
        return data

    def company_facts(self, cik: int, max_age_days=14):
        return self.get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json",
                             SEC_DIR / "companyfacts" / f"{cik:010d}.json", max_age_days, missing_ok=True)

    def submissions(self, cik: int):
        return self.get_json(f"https://data.sec.gov/submissions/CIK{cik:010d}.json",
                             SEC_DIR / "submissions" / f"{cik:010d}.json", 60, missing_ok=True)

    def current_tickers(self):
        return self.get_json("https://www.sec.gov/files/company_tickers.json", SEC_DIR / "company_tickers.json", 7)

    def search_symbol(self, ticker, start, end):
        """Full-text search for '"symbol TICKER"' in 10-K/10-Q filings inside [start, end]."""
        hits = Counter()
        for forms in ("10-K", "10-Q"):
            url = (f"https://efts.sec.gov/LATEST/search-index?q=%22symbol%20{ticker}%22&forms={forms}"
                   f"&dateRange=custom&startdt={start}&enddt={end}")
            safe = re.sub(r"[^A-Za-z0-9]", "_", ticker)
            d = self.get_json(url, SEC_DIR / "fts" / f"{safe}_{forms}_{start}_{end}.json", None, missing_ok=True) or {}
            for h in d.get("hits", {}).get("hits", []):
                ciks = h.get("_source", {}).get("ciks") or []
                if ciks:
                    hits[int(ciks[0])] += 1
        return hits


def norm_ticker(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", t.upper())


# ---------------------------------------------------------------------------
# XBRL facts -> point-in-time records
# ---------------------------------------------------------------------------

def _records(facts: dict, concepts: list, unit="USD", taxonomy="us-gaap") -> pd.DataFrame:
    """One record per period: the earliest filing of any listed concept (ties -> list order).
    Companies switch concepts over time (e.g. SalesRevenueNet -> RevenueFromContract...), and a
    preferred concept is often filed for an old period only later, as a comparative."""
    rows = []
    for pri, c in enumerate(concepts):
        for r in facts.get("facts", {}).get(taxonomy, {}).get(c, {}).get("units", {}).get(unit, []):
            if r.get("val") is None or not r.get("filed") or not r.get("end"):
                continue
            rows.append((pri, r.get("start"), r["end"], float(r["val"]), r["filed"]))
    if not rows:
        return pd.DataFrame(columns=["start", "end", "val", "filed"])
    df = pd.DataFrame(rows, columns=["pri", "start", "end", "val", "filed"])
    df["end"], df["filed"] = pd.to_datetime(df["end"]), pd.to_datetime(df["filed"])
    df["start"] = pd.to_datetime(df["start"])
    df = df[df["end"] <= df["filed"]]  # a period ending after its own filing is a tagging error (and would read future prices)
    df = df.sort_values(["filed", "pri"])
    key = ["start", "end"] if df["start"].notna().any() else ["end"]
    df = df.drop_duplicates(key, keep="first")
    return df.drop(columns="pri").reset_index(drop=True)


# Point-in-time consistency rule used by every derived series below: whenever several facts could
# supply a value (direct quarter vs year-to-date difference, which prior quarter, which year-ago
# period), the one filed EARLIEST wins. Then a value derived from the full history equals the one
# derived from only the filings available at any past date (test_qs_fund, and the run's audit).

def _earliest(cands):
    """cands: list of (filed, tiebreak, val). Earliest filing; ties -> smallest tiebreak."""
    return min(cands, key=lambda c: (c[0], c[1])) if cands else None


def quarters(rec: pd.DataFrame) -> pd.DataFrame:
    """Discrete quarterly values (end, val, filed) from direct 3-month facts and year-to-date differences."""
    if rec.empty or rec["start"].isna().all():
        return pd.DataFrame(columns=["end", "val", "filed"])
    r = rec.dropna(subset=["start"]).copy()
    r["dur"] = (r["end"] - r["start"]).dt.days
    cands = {}
    for x in r[(r.dur >= 80) & (r.dur <= 100)].itertuples():
        cands.setdefault(x.end, []).append((x.filed, 0, x.val))
    for _, g in r[(r.dur >= 80) & (r.dur <= 380)].groupby("start"):
        rows = list(g.sort_values("end").itertuples())
        for j, b_ in enumerate(rows):  # every pair, not only neighbours: a later-filed record in
            for a_ in rows[:j]:        # between must not hide an earlier-filed derivation
                if 80 <= b_.dur - a_.dur <= 100:
                    cands.setdefault(b_.end, []).append((max(a_.filed, b_.filed), 1, b_.val - a_.val))
    q = pd.DataFrame([(e, c[2], c[0]) for e, cs in cands.items() for c in [_earliest(cs)]], columns=["end", "val", "filed"])
    return q.sort_values("end").reset_index(drop=True)


def _prior(q: pd.DataFrame, end, lo, hi, target):
    """Row of q ending lo..hi days before `end`: earliest filed, ties -> closest to `target` days."""
    d = (end - q["end"]).dt.days
    m = q[(d >= lo) & (d <= hi)]
    if m.empty:
        return None
    gap = np.abs((end - m["end"]).dt.days.values - target)
    order = np.lexsort((gap, m["filed"].values.astype("datetime64[ns]").astype("int64")))
    return m.iloc[int(order[0])]


def ttm(rec: pd.DataFrame) -> pd.DataFrame:
    """Trailing-twelve-month records (end, val, filed): annual facts and four-quarter sums; per period
    end the earliest-filed candidate."""
    cols = ["end", "val", "filed"]
    if rec.empty or rec["start"].isna().all():
        return pd.DataFrame(columns=cols)
    r = rec.dropna(subset=["start"])
    dur = (r["end"] - r["start"]).dt.days
    cands = {}
    for x in r[(dur >= 350) & (dur <= 380)].itertuples():
        cands.setdefault(x.end, []).append((x.filed, 0, x.val))
    q = quarters(rec)
    for x in q.itertuples():
        parts, cur = [(x.val, x.filed)], x.end
        for _ in range(3):
            pr = _prior(q, cur, 80, 100, 91)
            if pr is None:
                break
            parts.append((pr.val, pr.filed))
            cur = pr["end"]
        if len(parts) == 4:
            cands.setdefault(x.end, []).append((max(f for _, f in parts), 1, float(sum(v for v, _ in parts))))
    t = pd.DataFrame([(e, c[2], c[0]) for e, cs in cands.items() for c in [_earliest(cs)]], columns=cols)
    return t.sort_values("end").reset_index(drop=True)


def yoy(t: pd.DataFrame, fn) -> pd.DataFrame:
    """fn(current, year_ago) on records whose ends are ~1 year apart (year-ago = earliest filed);
    filed = later of the two."""
    rows = []
    for x in t.itertuples():
        y = _prior(t, x.end, 350, 380, 365)
        if y is not None:
            v = fn(x.val, y.val)
            if v is not None and np.isfinite(v):
                rows.append((x.end, v, max(x.filed, y.filed)))
    return pd.DataFrame(rows, columns=["end", "val", "filed"])


def sue(q: pd.DataFrame, n=8, min_n=4) -> pd.DataFrame:
    """SUE at each quarter: its year-over-year change / std of the changes of the last n quarters
    that were already filed when this one was."""
    diffs = []
    for x in q.itertuples():
        y = _prior(q, x.end, 350, 380, 365)
        if y is not None:
            diffs.append((x.end, x.val - y.val, max(x.filed, y.filed)))
    rows = []
    for e, dv, f in diffs:
        past = [v for e2, v, f2 in diffs if e2 <= e and f2 <= f][-n:]
        if len(past) >= min_n and np.std(past) > 0:
            rows.append((e, dv / np.std(past), f))
    return pd.DataFrame(rows, columns=["end", "val", "filed"])


def asof(rec: pd.DataFrame, dates: pd.DatetimeIndex, max_age: int) -> pd.Series:
    """Value known at each date: latest period among records filed strictly before the date."""
    if rec is None or rec.empty:
        return pd.Series(np.nan, index=dates)
    r = rec.sort_values(["filed", "end"]).copy()
    r = r[r["end"] >= r["end"].cummax()]  # a late filing for an older period never replaces a newer one
    r["avail"] = r["filed"] + pd.Timedelta(days=1)
    # several periods can share one filing day: sort by (avail, end) so merge_asof, which takes the
    # last of equal keys, picks the latest period
    m = pd.merge_asof(pd.DataFrame({"d": dates}), r[["avail", "end", "val"]].sort_values(["avail", "end"], kind="mergesort"),
                      left_on="d", right_on="avail", direction="backward")
    v = m["val"].where((m["d"] - m["end"]).dt.days <= max_age)
    return pd.Series(v.values, index=dates)


def truncate(facts: dict, cut) -> dict:
    """Facts as they existed at the end of day `cut` (for the look-ahead audit)."""
    cut = str(pd.Timestamp(cut).date())
    out = {"facts": {}}
    for tax, cs in facts.get("facts", {}).items():
        out["facts"][tax] = {c: {"units": {u: [r for r in v if r.get("filed", "9999") <= cut] for u, v in d.get("units", {}).items()}}
                             for c, d in cs.items()}
    return out


def company_panel(facts: dict, dates: pd.DatetimeIndex, close: pd.Series) -> pd.DataFrame:
    """Raw (un-ranked) fundamental features for one company on `dates`."""
    A = lambda rec, kind: asof(rec, dates, MAX_AGE[kind])  # noqa: E731
    ni_r, rev_r = _records(facts, NI), _records(facts, REV)
    ni_t, rev_t, gp_t, op_t, cf_t = (ttm(x) for x in (ni_r, rev_r, _records(facts, GP), _records(facts, OPI), _records(facts, CFO)))
    assets_r, eq_r, liab_r = _records(facts, ASSETS), _records(facts, EQUITY), _records(facts, LIAB)
    flt = _records(facts, ["EntityPublicFloat"], taxonomy="dei")
    ni, rev, gp, op, cf = (A(x, "flow") for x in (ni_t, rev_t, gp_t, op_t, cf_t))
    assets, eq, liab = (A(x, "instant") for x in (assets_r, eq_r, liab_r))
    liab = liab.fillna(assets - eq)  # per date: tagged Liabilities if known then, else assets - equity
    # market value: float as of its own date, rolled forward with the adjusted close
    close = close.reindex(dates)
    mcap = pd.Series(np.nan, index=dates)
    if not flt.empty and close.notna().any():
        f = flt[flt.val > 0].copy()
        px_all = close.dropna()
        f["px0"] = [px_all.asof(e) if e >= px_all.index[0] else np.nan for e in f["end"]]
        f = f.dropna(subset=["px0"])
        if len(f):
            f["val"] = f["val"] / f["px0"]  # float in "adjusted shares"
            mcap = A(f[["end", "val", "filed"]], "float") * close
    pos = lambda s: s.where(s > 0)  # noqa: E731
    assets_p, mcap_p = pos(assets), pos(mcap)
    out = pd.DataFrame(index=dates)
    out["F_EP"], out["F_BM"], out["F_SP"], out["F_CFP"] = ni / mcap_p, eq / mcap_p, rev / mcap_p, cf / mcap_p
    out["F_SIZE"] = np.log(mcap_p)
    out["F_ROE"], out["F_ROA"] = ni / pos(eq), ni / assets_p
    out["F_GPA"], out["F_OPA"] = gp / assets_p, op / assets_p
    out["F_ACC"], out["F_LEV"] = (ni - cf) / assets_p, liab / assets_p
    out["F_REVG"] = A(yoy(rev_t, lambda a, b: a / b - 1 if b > 0 else None), "flow")
    out["F_NIG"] = A(yoy(ni_t, lambda a, b: a - b), "flow") / assets_p
    out["F_AG"] = A(yoy(assets_r[["end", "val", "filed"]] if not assets_r.empty else assets_r,
                        lambda a, b: a / b - 1 if b > 0 else None), "instant")
    out["F_SUE"] = A(sue(quarters(ni_r)), "flow")
    return out.replace([np.inf, -np.inf], np.nan)


# ---------------------------------------------------------------------------
# Ticker -> CIK, sectors
# ---------------------------------------------------------------------------

def filing_span(facts: dict):
    """(first, last) filed date over the core statements, or None."""
    fl = []
    for c in NI + REV + ASSETS:
        for u in facts.get("facts", {}).get("us-gaap", {}).get(c, {}).get("units", {}).values():
            fl += [r["filed"] for r in u if r.get("filed")]
    if not fl:
        return None
    return pd.Timestamp(min(fl)), pd.Timestamp(max(fl))


def max_float(facts: dict, a, b) -> float:
    vals = [r["val"] for r in facts.get("facts", {}).get("dei", {}).get("EntityPublicFloat", {}).get("units", {}).get("USD", [])
            if a - pd.Timedelta(days=400) <= pd.Timestamp(r["end"]) <= b]
    return float(max(vals)) if vals else 0.0


def validate(facts, a, b, need_float: bool):
    """A CIK fits a ticker's priced membership [a, b] if it filed statements during it (XBRL era)."""
    if not facts:
        return False, "no XBRL facts"
    span = filing_span(facts)
    if span is None:
        return False, "no core statements"
    lo = max(a, pd.Timestamp("2009-07-01"))
    if b < lo:
        return False, "membership ended before XBRL"
    overlap = (min(span[1] + pd.Timedelta(days=120), b) - max(span[0], lo)).days
    if overlap < 0.5 * (b - lo).days:
        return False, f"filings {span[0].date()}..{span[1].date()} cover <50% of {lo.date()}..{b.date()}"
    if need_float and max_float(facts, lo, b) < 1e9:
        return False, "public float never >= $1B during membership"
    return True, "ok"


LEGAL = {"INC", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "PLC", "NV", "SA", "AG", "LLC", "LP", "THE",
         "HOLDINGS", "HOLDING", "HOLDCO", "GROUP", "NEW", "DE", "PA", "MD", "MO", "NY"}


def clean_name(name: str) -> str:
    """Company name without punctuation, legal suffixes or 'Holdings' (a holding-company
    reorganisation keeps the business name): 'ExxonMobil Holdings Corp' -> 'EXXONMOBIL'."""
    words = re.findall(r"[A-Z0-9]+", (name or "").upper().replace("&", " AND "))
    return "".join(w for w in words if w not in LEGAL)


def span_overlap_days(facts, lo, hi) -> int:
    s = filing_span(facts)
    if s is None:
        return 0
    return max(0, (min(s[1] + pd.Timedelta(days=120), hi) - max(s[0], lo)).days)


def merge_facts(parts: list) -> dict:
    """Facts of several CIKs of one company (e.g. before/after a holding-company reorganisation)."""
    out = {"facts": {}}
    for f in parts:
        for tax, cs in (f or {}).get("facts", {}).items():
            for c, d in cs.items():
                tgt = out["facts"].setdefault(tax, {}).setdefault(c, {"units": {}})["units"]
                for u, v in d.get("units", {}).items():
                    tgt.setdefault(u, []).extend(v)
    return out


def resolve_ciks(sec: Sec, spans: dict, renames: dict, log=print) -> dict:
    """spans: {ticker: (first, last) priced member day}. renames: {old: new}.
    Returns {ticker: {"ciks": [...], "cik": first or None, "basis", "uncertain"}}.

    Trusted candidates: SEC's current ticker, the run's rename target, and name-matched
    predecessors of those (a reorganised company files under a new CIK with a short history).
    Full-text-search candidates are used only if trusted ones cover < 50% of the XBRL-era
    membership; they must not currently trade under a different symbol (unless that symbol is a
    later index member, i.e. a rename) and must report a public float >= $1B; one at most is
    added and the mapping is flagged uncertain."""
    cur, title = {}, {}
    for v in (sec.current_tickers() or {}).values():
        cur.setdefault(norm_ticker(v["ticker"]), int(v["cik_str"]))
        title.setdefault(int(v["cik_str"]), v["title"])
    starts = {norm_ticker(t): pd.Timestamp(a) for t, (a, _) in spans.items()}

    def identity_ok(cik, t, end):
        tick = [norm_ticker(x) for x in ((sec.submissions(cik) or {}).get("tickers") or [])]
        if not tick or norm_ticker(t) in tick:
            return True
        return any(x in starts and starts[x] >= end - pd.Timedelta(days=45) for x in tick)

    def predecessors(cik):
        name = clean_name(title.get(cik, ""))
        if len(name) < 4:
            return []
        found = []
        for q in {title[cik], re.sub(r"(?<=[a-z])(?=[A-Z])", " ", title[cik])}:
            url = f"https://efts.sec.gov/LATEST/search-index?keysTyped={requests_quote(q)}"
            d = sec.get_json(url, SEC_DIR / "entities" / f"{re.sub(r'[^A-Za-z0-9]', '_', q)}.json", 60, missing_ok=True) or {}
            for h in d.get("hits", {}).get("hits", []):
                c = int(h["_id"])
                if c != cik and clean_name(h["_source"].get("entity", "")) == name and c not in found:
                    found.append(c)
        return found

    out = {}
    for i, (t, (a, b)) in enumerate(sorted(spans.items())):
        if i and i % 100 == 0:
            log(f"  SEC mapping {i}/{len(spans)}")
        a, b = pd.Timestamp(a), pd.Timestamp(b)
        lo = max(a, pd.Timestamp("2009-07-01"))
        if b < lo:
            out[t] = {"ciks": [], "cik": None, "basis": "membership ended before XBRL (2009)", "uncertain": False}
            continue
        need = max((b - lo).days, 1)
        cands = []
        for basis, cik in [("SEC current ticker", cur.get(norm_ticker(t))),
                           ("ticker rename", cur.get(norm_ticker(renames.get(t, ""))) if t in renames else None)]:
            if cik is not None and cik not in [c for c, _ in cands]:
                cands.append((cik, basis))
                cands += [(p, "name-matched predecessor") for p in predecessors(cik) if p not in [c for c, _ in cands]]
        chosen, notes = [], []
        for cik, basis in cands:
            f = sec.company_facts(cik)
            ov = span_overlap_days(f, lo, b) if f else 0
            if ov >= min(90, 0.5 * need) and (basis != "name-matched predecessor" or identity_ok(cik, t, b)):
                chosen.append((cik, basis, ov))
            else:
                notes.append(f"CIK {cik} ({basis}): overlap {ov}d")
        uncertain = any(bs == "name-matched predecessor" for _, bs, _ in chosen)
        if sum(ov for _, _, ov in chosen) < 0.5 * need:
            hits = sec.search_symbol(t.replace("-", "."), str(lo.date()), str(b.date()))
            if not hits and "-" in t:
                hits = sec.search_symbol(t.replace("-", ""), str(lo.date()), str(b.date()))
            ranked = hits.most_common(4)
            for j, (cik, n) in enumerate(ranked):
                if sum(ov for _, _, ov in chosen) >= 0.5 * need:
                    break  # enough coverage: never add more searched companies than needed
                if cik in [c for c, _ in cands]:
                    continue
                f = sec.company_facts(cik)
                ov = span_overlap_days(f, lo, b) if f else 0
                runner_up = max([m for c, m in ranked if c != cik] or [0])
                dominant = n >= 10 and n >= 3 * runner_up  # e.g. a bank that later changed its symbol
                if ov < min(90, 0.5 * need):
                    notes.append(f"CIK {cik} (search): overlap {ov}d")
                elif not (identity_ok(cik, t, b) or dominant):
                    notes.append(f"CIK {cik} (search): now trades under another symbol")
                elif max_float(f, lo, b) < 1e9:
                    notes.append(f"CIK {cik} (search): float < $1B")
                else:
                    chosen.append((cik, f"SEC full-text search ('symbol {t}', {n} filings)", ov))
                    uncertain = True
        if chosen and sum(ov for _, _, ov in chosen) >= 0.5 * need:
            out[t] = {"ciks": [c for c, _, _ in chosen], "cik": chosen[0][0],
                      "basis": " + ".join(f"{bs} (CIK {c})" for c, bs, _ in chosen), "uncertain": uncertain}
        else:
            out[t] = {"ciks": [], "cik": None, "basis": "unresolved: " + ("; ".join(notes) or "no candidate"), "uncertain": False}
    return out


def facts_for(sec: Sec, m: dict) -> dict:
    parts = [sec.company_facts(c) for c in m.get("ciks") or ([m["cik"]] if m.get("cik") else [])]
    return parts[0] if len(parts) == 1 else merge_facts(parts)


def mapping_kind(m: dict) -> str:
    b = m["basis"]
    if not m.get("cik"):
        return "membership ended before XBRL" if b.startswith("membership ended") else "unresolved"
    if "full-text search" in b:
        return "via full-text search (uncertain)"
    if "predecessor" in b:
        return "with name-matched predecessor CIK (uncertain)"
    return "ticker rename" if b.startswith("ticker rename") else "SEC current ticker"


def requests_quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s)


SECTOR_RANGES = [  # (lo, hi, sector) on 4-digit SIC, first match wins
    (1300, 1399, "Energy"), (2900, 2999, "Energy"), (4920, 4925, "Energy"),
    (1000, 1499, "Materials"), (2400, 2499, "Materials"), (2600, 2699, "Materials"),
    (2800, 2829, "Materials"), (2850, 2899, "Materials"), (3000, 3399, "Materials"),
    (2830, 2836, "Health Care"), (3840, 3851, "Health Care"), (5120, 5129, "Health Care"), (8000, 8099, "Health Care"),
    (2000, 2199, "Consumer Staples"), (2840, 2844, "Consumer Staples"), (5140, 5149, "Consumer Staples"),
    (5400, 5499, "Consumer Staples"), (5912, 5912, "Consumer Staples"),
    (3570, 3579, "Information Technology"), (3600, 3629, "Information Technology"),
    (3640, 3699, "Information Technology"), (3800, 3839, "Information Technology"),
    (3852, 3899, "Information Technology"), (7370, 7379, "Information Technology"),
    (2700, 2799, "Communication Services"), (4800, 4899, "Communication Services"), (7800, 7999, "Communication Services"),
    (4900, 4999, "Utilities"),
    (6500, 6553, "Real Estate"), (6798, 6798, "Real Estate"),
    (6000, 6799, "Financials"),
    (2200, 2399, "Consumer Discretionary"), (2500, 2599, "Consumer Discretionary"),
    (3630, 3639, "Consumer Discretionary"), (3710, 3716, "Consumer Discretionary"), (3900, 3999, "Consumer Discretionary"),
    (5200, 5999, "Consumer Discretionary"), (7000, 7099, "Consumer Discretionary"),
    (1500, 1799, "Industrials"), (3400, 3569, "Industrials"), (3580, 3599, "Industrials"),
    (3700, 3799, "Industrials"), (4000, 4799, "Industrials"), (5000, 5199, "Industrials"),
    (7100, 7369, "Industrials"), (7380, 7799, "Industrials"), (8100, 8999, "Industrials"),
]


def sector_of_sic(sic) -> str:
    try:
        s = int(sic)
    except (TypeError, ValueError):
        return "Unknown"
    for lo, hi, name in SECTOR_RANGES:
        if lo <= s <= hi:
            return name
    return "Unknown"


def audit_company(args):
    """Point-in-time audit of one company: (ticker, [(cut, feature, truncated, full), ...] mismatches).
    args = (ticker, mapping, closes Series, full panel DataFrame, list of cut dates)."""
    t, m, close, full, cuts = args
    facts = facts_for(Sec(), m)
    bad = []
    for d in cuts:
        p = company_panel(truncate(facts, d), close.index[close.index <= d], close.loc[:d]).loc[d]
        for f in FEATURES:
            a, b = float(p[f]), float(full.loc[d, f])
            if (np.isnan(a) != np.isnan(b)) or (not np.isnan(a) and abs(a - b) > 1e-5 * max(abs(b), 1e-6)):
                bad.append((str(d.date()), f, a, b))
    return t, bad
