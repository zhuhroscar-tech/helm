"""Market-breadth series from point-in-time index members, and an honest time-series test.

Breadth is what a qlib universe adds to an ETF-timing strategy: LEAN with ETF prices alone can't see how many
of the index's members are healthy. Built from the files a universe export already wrote:
  helm/universes/<key>.csv   (ticker, start, end)  member spells (member AND priced)
  equity/usa/daily/<t>.zip   LEAN daily bars       adjusted prices
Output: helm/breadth/<key>.csv (date, pct_above_200, net_highs, dispersion, members) + <key>.json.
A row dated d uses closes up to d, so a strategy may only use it from the next trading day (HelmBreadth does that).

Series (direction pre-declared: higher = more bullish, except dispersion):
  pct_above_200  share of members whose close is above their own 200-day average
  net_highs      share of members at a 252-day high minus share at a 252-day low
  dispersion     cross-sectional standard deviation of members' 21-day returns (high = fragmented market)

Time-series test (development period only):
  - a signal on day t is compared with the benchmark's return from t+1 to t+1+h (no same-day look-ahead);
  - non-overlapping samples only (every h days), so n is the honest number of independent observations;
  - rank IC with its t-value, share of calendar years with the expected sign, and one pre-declared rule
    (in the market when the rule holds) compared with being out;
  - every (universe, series, horizon) tested is logged append-only; the bar is Bonferroni over all of them.
Timing decisions are rare (20 years at h=21 is ~240 observations), so most results will be weak; that is reported
as is, never loosened.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import math
import os
import zipfile
from pathlib import Path
from statistics import NormalDist

import numpy as np
import pandas as pd

SERIES = {
    "pct_above_200": {"direction": 1, "rule": (">", 0.5), "zh": "站上 200 日均线的成分股比例", "en": "share of members above their 200-day average"},
    "net_highs": {"direction": 1, "rule": (">", 0.0), "zh": "创 52 周新高减新低的成分股比例", "en": "share at a 52-week high minus share at a 52-week low"},
    "dispersion": {"direction": -1, "rule": ("<", "dev_median"), "zh": "成分股 21 日收益的分化程度", "en": "cross-sectional spread of members' 21-day returns"},
}
MIN_MEMBERS = 20          # fewer priced members than this on a day -> no value
ALPHA = 0.05
T_FLOOR = 2.0
WEAK_T = 1.65
MIN_N = 40                # independent observations needed for a "signal" verdict
SIGN_SHARE = 2 / 3


# ---------------------------------------------------------------------------
# Reading LEAN files
# ---------------------------------------------------------------------------

def read_lean_daily(zpath) -> pd.Series | None:
    """Close prices from a LEAN daily zip ("YYYYMMDD 00:00,o,h,l,c,v" in 1/10000 dollars)."""
    p = Path(zpath)
    if not p.exists():
        return None
    with zipfile.ZipFile(p) as z:
        names = z.namelist()
        if not names:
            return None
        text = z.read(names[0]).decode("utf-8", "replace")
    dates, closes = [], []
    for line in text.splitlines():
        parts = line.split(",")
        if len(parts) < 5:
            continue
        try:
            dates.append(dt.datetime.strptime(parts[0][:8], "%Y%m%d"))
            closes.append(float(parts[4]) / 10000.0)
        except ValueError:
            continue
    if not dates:
        return None
    s = pd.Series(closes, index=pd.DatetimeIndex(dates), dtype="float64")
    return s[~s.index.duplicated(keep="last")].sort_index()


def read_spells(path) -> dict:
    df = pd.read_csv(path)
    out = {}
    for r in df.itertuples(index=False):
        out.setdefault(str(r.ticker), []).append((pd.Timestamp(r.start), pd.Timestamp(r.end)))
    return out


def eligible_matrix(spells: dict, index: pd.DatetimeIndex) -> pd.DataFrame:
    m = pd.DataFrame(False, index=index, columns=sorted(spells))
    for t, sp in spells.items():
        for a, b in sp:
            m.loc[(m.index >= a) & (m.index <= b), t] = True
    return m


# ---------------------------------------------------------------------------
# Breadth
# ---------------------------------------------------------------------------

def build_breadth(closes: pd.DataFrame, eligible: pd.DataFrame) -> pd.DataFrame:
    """closes: dates x tickers (adjusted); eligible: same shape, True when the name is a member that day.
    Each indicator only uses a name on days it is a member and has enough of its own history."""
    closes = closes.sort_index()
    eligible = eligible.reindex(index=closes.index, columns=closes.columns).fillna(False).astype(bool)
    sma = closes.rolling(200, min_periods=200).mean()
    v200 = eligible & sma.notna() & closes.notna()
    above = (closes > sma) & v200
    n200 = v200.sum(axis=1)
    pct = (above.sum(axis=1) / n200).where(n200 >= MIN_MEMBERS)

    hi = closes.rolling(252, min_periods=252).max()
    lo = closes.rolling(252, min_periods=252).min()
    v252 = eligible & hi.notna() & closes.notna()
    n252 = v252.sum(axis=1)
    at_hi = ((closes >= hi) & v252).sum(axis=1)
    at_lo = ((closes <= lo) & v252).sum(axis=1)
    net = ((at_hi - at_lo) / n252).where(n252 >= MIN_MEMBERS)

    r21 = (closes / closes.shift(21) - 1).where(eligible)
    cnt = r21.notna().sum(axis=1)
    disp = r21.std(axis=1, ddof=1).where(cnt >= MIN_MEMBERS)

    out = pd.DataFrame({"pct_above_200": pct, "net_highs": net, "dispersion": disp, "members": eligible.sum(axis=1)})
    return out.dropna(how="all", subset=["pct_above_200", "net_highs", "dispersion"])


def lean_symbol(t: str) -> str:
    return t.strip().upper().replace("-", ".").lower()


def build_from_lean(data_dir, key: str) -> dict:
    data = Path(data_dir)
    upath = data / "helm" / "universes" / f"{key}.csv"
    if not upath.exists():
        raise FileNotFoundError(f"股票池 {key} 还没准备好：先 prepare_universe('{key}')")
    spells = read_spells(upath)
    series = {}
    for t in spells:
        s = read_lean_daily(data / "equity" / "usa" / "daily" / f"{lean_symbol(t)}.zip")
        if s is not None and len(s):
            series[t] = s
    if len(series) < MIN_MEMBERS:
        raise ValueError(f"股票池 {key} 只有 {len(series)} 只股票有 LEAN 价格，算不出市场宽度（至少 {MIN_MEMBERS} 只）")
    closes = pd.DataFrame(series).sort_index()
    elig = eligible_matrix({t: spells[t] for t in series}, closes.index)
    b = build_breadth(closes, elig)
    bdir = data / "helm" / "breadth"
    bdir.mkdir(parents=True, exist_ok=True)
    csv = b.copy()
    csv.index = csv.index.strftime("%Y-%m-%d")
    csv.index.name = "date"
    tmp = bdir / f"{key}.csv.tmp"
    csv.round(6).to_csv(tmp)
    os.replace(tmp, bdir / f"{key}.csv")
    meta = {"index": key, "start": str(b.index[0].date()), "end": str(b.index[-1].date()), "rows": int(len(b)),
            "names_with_prices": len(series), "members_median": int(b["members"].median()),
            "series": {k: {"zh": v["zh"], "en": v["en"], "direction": v["direction"]} for k, v in SERIES.items()},
            "built": dt.datetime.now().isoformat(timespec="seconds"), "csv": f"helm/breadth/{key}.csv",
            "note": "A row dated d uses closes up to d; strategies may use it from the next trading day (HelmBreadth)."}
    (bdir / f"{key}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    return meta


def read_breadth(data_dir, key: str) -> pd.DataFrame:
    p = Path(data_dir) / "helm" / "breadth" / f"{key}.csv"
    if not p.exists():
        raise FileNotFoundError(f"还没有 {key} 的市场宽度：先 build_breadth('{key}')")
    return pd.read_csv(p, index_col="date", parse_dates=["date"])


# ---------------------------------------------------------------------------
# Time-series test
# ---------------------------------------------------------------------------

def t_threshold(m: int, alpha: float = ALPHA) -> float:
    m = max(int(m), 1)
    return float(max(T_FLOOR, NormalDist().inv_cdf(1 - alpha / (2 * m))))


def registry_path() -> Path:
    return Path(os.environ.get("QS_TIMING_REGISTRY") or os.path.expanduser("~/.qlib/qs_cache/timing_registry.jsonl"))


def registry_read(path) -> list:
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def registry_add(path, universe: str, tests: list, extra=None) -> int:
    """Append-only. tests = [(series, horizon)]. A test already logged on this universe is not logged again.
    Returns how many distinct tests the universe has now."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    have = {(r.get("series"), r.get("horizon")) for r in registry_read(p) if r.get("universe") == universe}
    with open(p, "a") as fh:
        for s, h in tests:
            if (s, h) in have:
                continue
            fh.write(json.dumps({"universe": universe, "series": s, "horizon": int(h),
                                 "at": dt.datetime.now().isoformat(timespec="seconds"), **(extra or {})}) + "\n")
            have.add((s, h))
    return len(have)


def _rank_ic(x: np.ndarray, y: np.ndarray):
    n = len(x)
    if n < 3:
        return None, None
    rx = pd.Series(x).rank().to_numpy()
    ry = pd.Series(y).rank().to_numpy()
    if np.std(rx) == 0 or np.std(ry) == 0:
        return 0.0, 0.0
    ic = float(np.corrcoef(rx, ry)[0, 1])
    t = ic * math.sqrt((n - 2) / max(1e-12, 1 - ic * ic))
    return ic, float(t)


def _welch(a: np.ndarray, b: np.ndarray):
    if len(a) < 2 or len(b) < 2:
        return None
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    if va + vb <= 0:
        return None
    return float((a.mean() - b.mean()) / math.sqrt(va + vb))


def forward_returns(bench: pd.Series, h: int) -> pd.Series:
    """Return from the next day's close to h days later: fr(t) = close[t+1+h] / close[t+1] - 1."""
    c = bench.sort_index()
    return (c.shift(-(1 + h)) / c.shift(-1) - 1)


def test_series(sig: pd.Series, bench: pd.Series, h: int, direction: int, rule, dev_start, dev_end) -> dict:
    fr = forward_returns(bench, h)
    df = pd.concat({"s": sig, "r": fr}, axis=1).dropna()
    df = df[(df.index >= pd.Timestamp(dev_start)) & (df.index <= pd.Timestamp(dev_end))]
    # the forward window must also end inside the development period
    last_ok = bench.index[bench.index <= pd.Timestamp(dev_end)]
    if len(last_ok) > h + 1:
        df = df[df.index <= last_ok[-(h + 2)]]
    sample = df.iloc[::h]
    n = int(len(sample))
    ic, t = _rank_ic(sample["s"].to_numpy(), sample["r"].to_numpy())
    years = {}
    for y, g in df.groupby(df.index.year):
        if len(g) >= 60:
            yic, _ = _rank_ic(g["s"].to_numpy(), g["r"].to_numpy())
            if yic is not None:
                years[int(y)] = round(yic, 4)
    pos = [v for v in years.values() if v * direction > 0]
    op, thr = rule
    if thr == "dev_median":
        thr = float(df["s"].median()) if len(df) else float("nan")
    on = sample["s"] > thr if op == ">" else sample["s"] < thr
    a, b = sample["r"][on].to_numpy(), sample["r"][~on].to_numpy()
    return {
        "horizon": h, "n": n, "ic": None if ic is None else round(ic, 4), "t": None if t is None else round(t, 3),
        "t_directional": None if t is None else round(t * direction, 3),
        "years": years, "year_sign_share": round(len(pos) / len(years), 3) if years else None,
        "rule": {"op": op, "threshold": round(float(thr), 6) if thr == thr else None,
                 "share_on": round(float(on.mean()), 3) if n else None,
                 "mean_on": round(float(a.mean()), 5) if len(a) else None,
                 "mean_off": round(float(b.mean()), 5) if len(b) else None,
                 "t": None if _welch(a, b) is None else round(_welch(a, b), 3)},
    }


def judge(results: list, bar: float) -> dict:
    best = max((r for r in results if r["t_directional"] is not None), key=lambda r: r["t_directional"], default=None)
    if best is None:
        return {"verdict": "none", "verdict_zh": "没有信号", "reasons_zh": ["样本太少，算不出统计量"]}
    reasons = []
    tdir, n, share = best["t_directional"], best["n"], best["year_sign_share"]
    if tdir >= bar and n >= MIN_N and (share is None or share >= SIGN_SHARE):
        v = "signal"
        reasons.append(f"{best['horizon']} 天：方向一致的 t = {tdir}，超过多重检验门槛 {bar:.2f}，{n} 个独立样本")
    elif tdir >= WEAK_T:
        v = "weak"
        if tdir < bar:
            reasons.append(f"{best['horizon']} 天：t = {tdir}，没过多重检验门槛 {bar:.2f}")
        if n < MIN_N:
            reasons.append(f"独立样本只有 {n} 个（少于 {MIN_N}），证据不够")
        if share is not None and share < SIGN_SHARE:
            reasons.append(f"只有 {share:.0%} 的年份方向一致")
    else:
        v = "none"
        reasons.append(f"最好的持有期 {best['horizon']} 天 t = {tdir}，和随机分不开")
    return {"verdict": v, "verdict_zh": {"signal": "有信号", "weak": "信号弱", "none": "没有信号"}[v], "reasons_zh": reasons, "best_horizon": best["horizon"]}


def run_test(breadth: pd.DataFrame, bench: pd.Series, universe: str, series: list, horizons: list, dev_start, dev_end,
             registry=None, extra=None) -> dict:
    unknown = [s for s in series if s not in SERIES]
    if unknown:
        raise ValueError(f"不认识的宽度序列：{unknown}（可选：{list(SERIES)}）")
    horizons = sorted({int(h) for h in horizons})
    if not horizons or min(horizons) < 5 or max(horizons) > 252:
        raise ValueError("持有天数要在 5 到 252 之间")
    m = registry_add(registry or registry_path(), universe, [(s, h) for s in series for h in horizons], extra)
    bar = t_threshold(m)
    out = {"universe": universe, "dev_window": [str(pd.Timestamp(dev_start).date()), str(pd.Timestamp(dev_end).date())],
           "tests_on_universe": m, "t_threshold": round(bar, 3), "series": {}}
    for s in series:
        meta = SERIES[s]
        res = [test_series(breadth[s].dropna(), bench, h, meta["direction"], meta["rule"], dev_start, dev_end) for h in horizons]
        out["series"][s] = {"label_zh": meta["zh"], "label_en": meta["en"], "direction": meta["direction"], "horizons": res, **judge(res, bar)}
    sig = [s for s, r in out["series"].items() if r["verdict"] == "signal"]
    weak = [s for s, r in out["series"].items() if r["verdict"] == "weak"]
    small = min((r["n"] for v in out["series"].values() for r in v["horizons"]), default=0)
    if sig:
        out["summary_zh"] = f"开发期里「{'」「'.join(SERIES[s]['zh'] for s in sig)}」对后续大盘收益有经得起多重检验的预测力。这还不是样本外结论。"
    elif weak:
        out["summary_zh"] = f"「{'」「'.join(SERIES[s]['zh'] for s in weak)}」有一点迹象但不够硬，不建议直接当过滤条件用。"
    else:
        out["summary_zh"] = "开发期里这些宽度指标都预测不了后续大盘收益：和随机分不开。"
    if small < MIN_N:
        out["summary_zh"] += f" 注意：择时每 {horizons[0]} 天才算一个独立样本，最少的只有 {small} 个，统计上很难证明有效。"
    return out
