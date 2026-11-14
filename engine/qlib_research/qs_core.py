"""Pure, Qlib-free building blocks for the quant-strategy pipeline.

Everything here is deterministic and unit-tested by test_qs_core.py:
  * chronological split design with label purging
  * forward-label definitions that match the simulated execution timing
  * a share/cash-accounted portfolio simulator (signal at close t, fill at open t+1)
  * metrics, IC statistics, block bootstrap, verdict rules

Timing convention used everywhere
---------------------------------
Features for date t use data up to and including the close of t.
The order is filled at the OPEN of t+1.
The h-day label for date t is  open(t+1+h) / open(t+1) - 1,
so the label measures exactly the return the simulated position earns.
A training sample at date t is "known" only after open(t+1+h); the purge
removes the last (h + 1) trading days before any later segment starts.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Labels and splits
# ---------------------------------------------------------------------------

def label_expr(h: int) -> str:
    """Qlib expression for the h-day open-to-open forward return from t+1."""
    return f"Ref($open, -{h + 1})/Ref($open, -1) - 1"


def purge_days(h: int) -> int:
    """Trading days to drop at the end of a training segment for horizon h."""
    return h + 1


@dataclass
class Fold:
    name: str
    train: tuple
    valid: tuple
    test: tuple


def _shift(cal: pd.DatetimeIndex, date, n: int) -> pd.Timestamp:
    """Trading day n positions from the first calendar day >= date (n may be negative)."""
    i = int(cal.searchsorted(pd.Timestamp(date)))
    i = min(max(i + n, 0), len(cal) - 1)
    return cal[i]


def design_splits(cal: pd.DatetimeIndex, start, holdout_years: float, h: int,
                  min_train_years: int = 5, valid_years: int = 1) -> dict:
    """Chronological walk-forward folds plus an untouched final holdout.

    Every training/validation segment ends `purge_days(h)` trading days before the
    next segment starts, so no label used for fitting or early stopping overlaps a
    later evaluation period.
    """
    cal = pd.DatetimeIndex(cal).sort_values()
    cal = cal[cal >= pd.Timestamp(start)]
    end = cal[-1]
    holdout_start = _shift(cal, end - pd.DateOffset(days=int(round(365.25 * holdout_years))), 0)
    p = purge_days(h)
    first_test_year = cal[0].year + min_train_years + valid_years
    folds = []
    for y in range(first_test_year, holdout_start.year + 1):
        test_start = _shift(cal, pd.Timestamp(f"{y}-01-01"), 0)
        if test_start >= holdout_start:
            break
        test_end = min(_shift(cal, pd.Timestamp(f"{y + 1}-01-01"), -1), _shift(cal, holdout_start, -1))
        valid_start = _shift(cal, pd.Timestamp(f"{y - valid_years}-01-01"), 0)
        folds.append(Fold(
            name=str(y),
            train=(cal[0], _shift(cal, valid_start, -p - 1)),
            valid=(valid_start, _shift(cal, test_start, -p - 1)),
            test=(test_start, test_end),
        ))
    # Final model for the holdout: same rule, segments end before holdout_start.
    hv_start = _shift(cal, holdout_start - pd.DateOffset(years=valid_years), 0)
    final = Fold("holdout",
                 train=(cal[0], _shift(cal, hv_start, -p - 1)),
                 valid=(hv_start, _shift(cal, holdout_start, -p - 1)),
                 test=(holdout_start, end))
    if not folds:
        raise ValueError("Not enough history for any walk-forward fold; lower min_train_years "
                         "or holdout_years, or extend the data.")
    return {"folds": folds, "final": final, "holdout_start": holdout_start, "end": end,
            "purge_days": p, "horizon": h}


def splits_to_json(s: dict) -> dict:
    d = lambda x: pd.Timestamp(x).strftime("%Y-%m-%d")
    f = lambda fo: {"name": fo.name, "train": [d(fo.train[0]), d(fo.train[1])],
                    "valid": [d(fo.valid[0]), d(fo.valid[1])], "test": [d(fo.test[0]), d(fo.test[1])]}
    return {"folds": [f(x) for x in s["folds"]], "final": f(s["final"]),
            "holdout_start": d(s["holdout_start"]), "end": d(s["end"]),
            "purge_days": s["purge_days"], "horizon": s["horizon"]}


def splits_from_json(j: dict) -> dict:
    t = pd.Timestamp
    f = lambda x: Fold(x["name"], tuple(map(t, x["train"])), tuple(map(t, x["valid"])), tuple(map(t, x["test"])))
    return {"folds": [f(x) for x in j["folds"]], "final": f(j["final"]),
            "holdout_start": t(j["holdout_start"]), "end": t(j["end"]),
            "purge_days": j["purge_days"], "horizon": j["horizon"]}


def check_no_overlap(s: dict, cal: pd.DatetimeIndex) -> list:
    """Return a list of violations (empty == OK). Label of the last training day
    must be fully realised before the next segment's first day."""
    cal = pd.DatetimeIndex(cal)
    h = s["horizon"]
    problems = []
    for fo in s["folds"] + [s["final"]]:
        for a, b, tag in [(fo.train, fo.valid, "train->valid"), (fo.valid, fo.test, "valid->test")]:
            last = int(cal.searchsorted(a[1]))
            label_end = last + 1 + h  # index of open(t+1+h)
            nxt = int(cal.searchsorted(b[0]))
            if label_end >= nxt:
                problems.append(f"{fo.name} {tag}: label of {a[1].date()} ends at idx {label_end} >= {nxt}")
        if fo.name != "holdout" and fo.test[1] >= s["holdout_start"]:
            problems.append(f"{fo.name}: test overlaps holdout")
    return problems


# ---------------------------------------------------------------------------
# Selection rules
# ---------------------------------------------------------------------------

def topk_dropout(scores: pd.Series, held: list, k: int, n_drop) -> list:
    """Qlib-style TopkDropout. n_drop=None -> plain top-k each rebalance.
    Otherwise sell at most n_drop held names ranked worst (only if outside the top k)
    and refill with the best non-held names."""
    scores = scores.dropna().sort_values(ascending=False)
    if n_drop is None or not held:
        return list(scores.index[:k])
    held = [s for s in held if s in scores.index]
    rank = {s: i for i, s in enumerate(scores.index)}
    held_sorted = sorted(held, key=lambda s: rank[s])
    drop = [s for s in held_sorted[::-1] if rank[s] >= k][:n_drop]
    keep = [s for s in held_sorted if s not in drop]
    buy = [s for s in scores.index if s not in keep][: max(k - len(keep), 0)]
    return keep + buy


# ---------------------------------------------------------------------------
# Simulator
# ---------------------------------------------------------------------------

def simulate(opens: pd.DataFrame, closes: pd.DataFrame, targets: dict,
             cost_bps: float = 10.0, initial: float = 1.0, start=None, end=None) -> pd.DataFrame:
    """Share/cash-accounted long-only simulation.

    targets: {signal_date: pd.Series(weights by ticker)}. Weights are fractions of
    equity (sum <= 1; the remainder stays in cash earning 0%). Each target is executed
    at the OPEN of the first trading day strictly after signal_date.
    cost_bps is charged on every dollar bought or sold (one-way).
    Holdings are shares, so weights drift between rebalances.
    Names without a valid open on the execution day are not traded (left as-is if
    held, skipped if new; the unspent weight stays in cash).
    """
    dates = opens.index
    if start is not None:
        dates = dates[dates >= pd.Timestamp(start)]
    if end is not None:
        dates = dates[dates <= pd.Timestamp(end)]
    o = opens.reindex(dates)
    c = closes.reindex(dates).ffill()
    rate = cost_bps / 1e4
    exec_map = {}
    all_dates = opens.index
    for sd, w in targets.items():
        i = int(all_dates.searchsorted(pd.Timestamp(sd), side="right"))
        if i < len(all_dates) and all_dates[i] in o.index:
            exec_map[all_dates[i]] = w  # later signals for the same exec day overwrite earlier
    cash = float(initial)
    shares = pd.Series(0.0, index=opens.columns)
    last_px = pd.Series(np.nan, index=opens.columns)
    data_end = closes.apply(lambda s: s.last_valid_index())  # delisted names: prices stop for good
    rows = []
    for dt in dates:
        op = o.loc[dt]
        mark_open = op.fillna(last_px).fillna(0.0)
        cost = traded = 0.0
        gone = shares.index[(shares > 0) & data_end.notna() & (data_end < dt)]
        if len(gone):  # sold at the last available close (true delisting proceeds unknown)
            val = float((shares[gone] * last_px[gone].fillna(0)).sum())
            cash += val * (1 - rate)
            shares[gone] = 0.0
            cost += val * rate
            traded += val
        if dt in exec_map:
            w = exec_map[dt].reindex(opens.columns).fillna(0.0).clip(lower=0)
            if w.sum() > 1 + 1e-9:
                w = w / w.sum()
            equity_open = cash + float((shares * mark_open).sum())
            tradable = op.notna() & (op > 0)
            desired = shares.copy()
            desired[tradable] = (w[tradable] * equity_open / op[tradable])
            delta = (desired - shares).where(tradable, 0.0)
            sells = (-delta).clip(lower=0)
            buys = delta.clip(lower=0)
            sell_val = float((sells * op.fillna(0)).sum())
            cash += sell_val * (1 - rate)
            shares -= sells
            buy_val = float((buys * op.fillna(0)).sum())
            need = buy_val * (1 + rate)
            if need > cash and need > 0:  # scale buys so cash never goes negative
                scale = max(cash, 0.0) / need
                buys *= scale
                buy_val *= scale
            cash -= buy_val * (1 + rate)
            shares += buys
            traded += sell_val + buy_val
            cost += (sell_val + buy_val) * rate
        cl = c.loc[dt]
        last_px = cl.where(cl.notna(), last_px)
        invested = float((shares * last_px.fillna(0)).sum())
        nav = cash + invested
        rows.append((dt, nav, cash, invested, cost, traded, int((shares > 1e-12).sum())))
        assert cash >= -1e-9, "cash went negative"
    df = pd.DataFrame(rows, columns=["date", "nav", "cash", "invested", "cost", "traded", "n_pos"]).set_index("date")
    df["exposure"] = df["invested"] / df["nav"]
    return df


def build_targets(scores: pd.DataFrame, signal_dates, k: int, n_drop=None,
                  exposure: dict | None = None) -> dict:
    """scores: DataFrame (date x ticker). Returns {signal_date: weights}."""
    targets, held = {}, []
    for d in signal_dates:
        if d not in scores.index:
            continue
        s = scores.loc[d].dropna()
        if len(s) < k:
            continue
        held = topk_dropout(s, held, k, n_drop)
        e = 1.0 if exposure is None else float(exposure.get(d, 1.0))
        targets[d] = pd.Series(e / len(held), index=held)
    return targets


def sector_counts(n_by_sector: pd.Series, k: int) -> pd.Series:
    """Split k slots across sectors in proportion to their eligible names (largest remainder),
    never more slots than a sector has names."""
    n_by_sector = n_by_sector[n_by_sector > 0]
    k = int(min(k, n_by_sector.sum()))
    raw = n_by_sector / n_by_sector.sum() * k
    out = np.floor(raw).astype(int)
    rem = (raw - out).sort_values(ascending=False)
    for s in rem.index:
        if out.sum() >= k:
            break
        if out[s] < n_by_sector[s]:
            out[s] += 1
    return out


def build_targets_balanced(scores: pd.DataFrame, sectors: dict, signal_dates, k: int,
                           exposure: dict | None = None) -> dict:
    """Sector-balanced long-only top-K: each sector gets slots in proportion to its share of the
    scored names, filled with that sector's best-scored names; equal weight."""
    targets = {}
    for d in signal_dates:
        if d not in scores.index:
            continue
        s = scores.loc[d].dropna()
        if len(s) < k:
            continue
        sec = pd.Series({t: sectors.get(t, "Unknown") for t in s.index})
        cnt = sector_counts(sec.value_counts(), k)
        held = []
        for name, n in cnt.items():
            if n > 0:
                held += list(s[sec == name].sort_values(ascending=False).index[:n])
        e = 1.0 if exposure is None else float(exposure.get(d, 1.0))
        targets[d] = pd.Series(e / len(held), index=held)
    return targets


def matched_targets(scores: pd.DataFrame, strategy_targets: dict, groups: dict | None = None) -> dict:
    """Baseline portfolio with the strategy's turnover and group mix.

    At every strategy rebalance, in each group (sector, or one group), the baseline holds as many
    names as the strategy and keeps as many of its previous holdings as the strategy kept of its
    own; it keeps its best-scored previous holdings and fills the rest with its best-scored other
    eligible names (eligible = non-NaN score). With random scores this is a random portfolio that
    trades exactly as often as the strategy; with momentum scores, a momentum portfolio that does.
    Equal weight at each rebalance, fully invested."""
    g = (lambda t: groups.get(t, "Unknown")) if groups else (lambda t: "all")
    out, prev_s, prev_b = {}, set(), set()
    for d in sorted(strategy_targets):
        if d not in scores.index:
            continue
        sel = set(strategy_targets[d].index)
        s = scores.loc[d].dropna()
        held = []
        for grp in sorted({g(t) for t in sel}):
            k_g = sum(1 for t in sel if g(t) == grp)
            kept_g = sum(1 for t in sel & prev_s if g(t) == grp)
            pool = s[[t for t in s.index if g(t) == grp]]
            old = pool[[t for t in pool.index if t in prev_b]].sort_values(ascending=False)
            keep = list(old.index[:min(kept_g, k_g)])
            new = pool.drop(index=keep).drop(index=[t for t in pool.index if t in prev_b], errors="ignore")
            held += keep + list(new.sort_values(ascending=False).index[:k_g - len(keep)])
        if held:
            out[d] = pd.Series(1.0 / len(held), index=held)
        prev_s, prev_b = sel, set(held)
    return out


def sector_demean(label: pd.Series, sectors: dict) -> pd.Series:
    """Label minus its (date, sector) mean: the part of a return a within-sector ranking can earn."""
    sec = label.index.get_level_values(1).map(lambda t: sectors.get(t, "Unknown"))
    g = [label.index.get_level_values(0), sec]
    return label - label.groupby(g).transform("mean")


def rebalance_dates(cal: pd.DatetimeIndex, start, end, every: int) -> list:
    cal = cal[(cal >= pd.Timestamp(start)) & (cal <= pd.Timestamp(end))]
    return list(cal[::every])


# ---------------------------------------------------------------------------
# Risk overlays: invested fraction at each signal date, from data up to that close only
# ---------------------------------------------------------------------------

def vol_exposure(unscaled_ret: pd.Series, sig_dates, target_vol: float, lookback: int, floor: float = 0.2) -> dict:
    """Vol targeting: target / trailing realised vol of the un-scaled strategy, clipped to [floor, 1]."""
    rv = unscaled_ret.rolling(lookback, min_periods=lookback // 2).std() * np.sqrt(252)
    return {d: float(np.clip(target_vol / rv.get(d, np.nan), floor, 1.0))
            if pd.notna(rv.get(d, np.nan)) and rv.get(d) > 0 else 1.0 for d in sig_dates}


def drawdown_exposure(unscaled_ret: pd.Series, sig_dates, threshold: float, cut: float) -> dict:
    """Drawdown control: invest `cut` while the un-scaled strategy is more than `threshold`
    below its running peak (measured at the signal close), otherwise fully."""
    nav = (1 + unscaled_ret.fillna(0.0)).cumprod()
    dd = nav / nav.cummax() - 1
    return {d: (cut if dd.get(d, 0.0) <= -threshold else 1.0) for d in sig_dates}


def trend_exposure(market_ret: pd.Series, sig_dates, lookback: int, cut: float) -> dict:
    """Trend filter: invest fully while the equal-weight universe index is at or above its
    `lookback`-day moving average at the signal close, otherwise invest `cut`."""
    level = (1 + market_ret.fillna(0.0)).cumprod()
    ma = level.rolling(lookback, min_periods=lookback).mean()
    return {d: (1.0 if pd.isna(ma.get(d, np.nan)) or level.get(d) >= ma.get(d) else cut) for d in sig_dates}


OVERLAY_GRIDS = {
    "vol_target": [{"target_vol": tv, "lookback": lb} for tv in (0.10, 0.15, 0.20, 0.25, 0.30) for lb in (20, 60)],
    "drawdown_control": [{"threshold": th, "cut": c} for th in (0.10, 0.15, 0.20, 0.25, 0.30) for c in (0.5, 0.25)],
    "trend_filter": [{"lookback": lb, "cut": c} for lb in (50, 100, 150, 200, 250) for c in (0.5, 0.25)],
}


def overlay_exposure(family: str, params: dict, unscaled_ret: pd.Series, market_ret: pd.Series, sig_dates) -> dict:
    if family == "vol_target":
        return vol_exposure(unscaled_ret, sig_dates, params["target_vol"], params["lookback"], params.get("floor", 0.2))
    if family == "drawdown_control":
        return drawdown_exposure(unscaled_ret, sig_dates, params["threshold"], params["cut"])
    if family == "trend_filter":
        return trend_exposure(market_ret, sig_dates, params["lookback"], params["cut"])
    raise ValueError(family)


def choose_overlay(results: dict, min_gain: float = 0.10, min_breadth: float = 0.6) -> dict:
    """results: family -> list of {"params", "delta_sharpe"}. A family qualifies only if its best
    point gains >= min_gain Sharpe AND >= min_breadth of its own grid improves (a smooth surface,
    not one lucky cell). Among qualifying families the largest best gain wins; else no overlay."""
    summary, best = {}, None
    for fam, pts in results.items():
        ds = np.array([p["delta_sharpe"] for p in pts], dtype=float)
        i = int(np.nanargmax(ds))
        s = {"best_params": pts[i]["params"], "best_delta_sharpe": float(ds[i]),
             "fraction_improving": float((ds > 0).mean()), "n": int(len(ds))}
        s["qualifies"] = bool(s["best_delta_sharpe"] >= min_gain and s["fraction_improving"] >= min_breadth)
        summary[fam] = s
        if s["qualifies"] and (best is None or s["best_delta_sharpe"] > summary[best]["best_delta_sharpe"]):
            best = fam
    return {"families": summary, "chosen_family": best,
            "chosen": summary[best]["best_params"] if best else None}


# ---------------------------------------------------------------------------
# Permutation control
# ---------------------------------------------------------------------------

def shuffle_within_date(label: pd.Series, until, seed: int) -> pd.Series:
    """Shuffle non-missing labels across names within each date on or before `until`
    (the training window). Dates after `until`, and the positions of missing labels, are unchanged."""
    v = label.values.copy()
    rng = np.random.default_rng(seed)
    d = label.index.get_level_values(0)
    ok = (d <= pd.Timestamp(until)) & ~np.isnan(v)
    pos = pd.Series(np.arange(len(v))[ok], index=d[ok])
    for _, idx in pos.groupby(level=0):
        ii = idx.values
        v[ii] = v[rng.permutation(ii)]
    return pd.Series(v, index=label.index, name=label.name)


def permutation_p(real: float, perms) -> dict:
    """Empirical one-sided p-value (1 + #perm >= real) / (1 + n) and a z-score for scale."""
    a = np.asarray(perms, dtype=float)
    if len(a) == 0:
        return {"p": None, "z": float("nan"), "n": 0, "min_attainable_p": None}
    return {"p": float((1 + (a >= real).sum()) / (1 + len(a))),
            "z": float((real - a.mean()) / a.std()) if a.std() > 0 else float("nan"),
            "n": int(len(a)), "min_attainable_p": float(1 / (1 + len(a)))}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def perf(nav: pd.Series) -> dict:
    nav = nav.dropna()
    r = nav.pct_change().dropna()
    if len(r) < 5:
        return {}
    years = len(r) / 252
    cagr = (nav.iloc[-1] / nav.iloc[0]) ** (1 / years) - 1 if nav.iloc[-1] > 0 else -1.0
    vol = r.std() * math.sqrt(252)
    sharpe = (r.mean() * 252) / vol if vol > 0 else 0.0
    dd = nav / nav.cummax() - 1
    mdd = float(dd.min())
    return {"total_return": float(nav.iloc[-1] / nav.iloc[0] - 1), "cagr": float(cagr),
            "ann_vol": float(vol), "sharpe": float(sharpe), "max_drawdown": mdd,
            "calmar": float(cagr / abs(mdd)) if mdd < 0 else float("nan"),
            "start": str(nav.index[0].date()), "end": str(nav.index[-1].date()), "days": int(len(r))}


def sim_stats(sim: pd.DataFrame) -> dict:
    out = perf(sim["nav"])
    yrs = max(len(sim) / 252, 1e-9)
    out["annual_turnover"] = float((sim["traded"] / sim["nav"]).sum() / yrs)
    out["total_cost_pct_of_initial"] = float(sim["cost"].sum() / sim["nav"].iloc[0])
    out["avg_exposure"] = float(sim["exposure"].mean())
    return out


def annual_returns(nav: pd.Series) -> pd.Series:
    """Calendar-year returns; the first year runs from the first NAV point."""
    nav = nav.dropna()
    ye = nav.groupby(nav.index.year).last()
    prev = ye.shift(1)
    prev.iloc[0] = nav.iloc[0]
    return ye / prev - 1


def excess_stats(nav: pd.Series, bench: pd.Series) -> dict:
    a = pd.concat([nav, bench], axis=1).dropna()
    r = a.pct_change().dropna()
    ex = r.iloc[:, 0] - r.iloc[:, 1]
    te = ex.std() * math.sqrt(252)
    return {"ann_excess_arith": float(ex.mean() * 252), "tracking_error": float(te),
            "information_ratio": float(ex.mean() * 252 / te) if te > 0 else 0.0,
            "total_return_diff": float(a.iloc[-1, 0] / a.iloc[0, 0] - a.iloc[-1, 1] / a.iloc[0, 1])}


def daily_ic(pred: pd.Series, label: pd.Series, min_names: int = 5) -> pd.Series:
    """Spearman IC per date. pred/label indexed by (datetime, instrument)."""
    df = pd.concat({"p": pred, "l": label}, axis=1).dropna()
    def f(g):
        if len(g) < min_names:
            return np.nan
        return g["p"].rank().corr(g["l"].rank())
    return df.groupby(level=0).apply(f).dropna()


# ---------------------------------------------------------------------------
# Ridge baseline (linear model with an L2 penalty) for the walk-forward model
# ---------------------------------------------------------------------------
# A plain linear model fitted on the same features, labels and folds as LightGBM. It answers one
# question: does the nonlinear model add anything a regularised linear model does not? It is a
# diagnostic only: it never replaces the main model, so it adds no trial to any count.

RIDGE_ALPHAS = (1e-4, 1e-3, 1e-2, 1e-1, 1.0, 10.0)  # penalty per row; per-date ranked features have variance ~1/12


def cs_rank_features(X: pd.DataFrame) -> pd.DataFrame:
    """Per-date percentile rank of every feature, centred to [-0.5, 0.5]; missing values -> 0 (that
    date's middle). Puts all features on one scale (so one penalty fits all) and caps outliers. Uses
    only the same date's cross-section, so it cannot look ahead."""
    return (X.groupby(level=0).rank(pct=True) - 0.5).fillna(0.0)


def rerank_among_eligible(feat: pd.DataFrame, elig: pd.Series) -> pd.DataFrame:
    """Re-rank every feature per date among that date's ELIGIBLE rows only, on CSRankNorm's (pct - 0.5) x 3.46
    scale. Rows that are not eligible keep their values (they get no label and are never traded). Index level 0
    must be the date. Used for Alpha158, whose Qlib CSRankNorm ranked across every name ever priced, including
    names that only join the index later."""
    ef = elig.reindex(feat.index, fill_value=False).to_numpy(dtype=bool)
    out = feat.copy()
    if ef.any():
        rk = feat[ef].groupby(level=0).rank(pct=True)
        out.loc[ef, :] = ((rk - 0.5) * 3.46).astype(feat.dtypes.iloc[0]).values
    return out


def ridge_fit(Xa: np.ndarray, y: np.ndarray, alpha: float) -> np.ndarray:
    """Ridge weights w = (XᵀX + alpha·n·I)⁻¹ Xᵀy. Features and labels are centred per date, so no
    intercept is needed. Solved with np.linalg.solve (never forms the inverse)."""
    Xa = np.asarray(Xa, dtype="float64")
    y = np.asarray(y, dtype="float64")
    n, d = Xa.shape
    return np.linalg.solve(Xa.T @ Xa + alpha * n * np.eye(d), Xa.T @ y)


def ridge_fold(Xr: pd.DataFrame, label: pd.Series, train, valid, test, alphas=RIDGE_ALPHAS, min_names: int = 5) -> dict:
    """One walk-forward fold. Xr: per-date ranked features (cs_rank_features). label: forward return.
    train / valid / test: boolean masks over Xr's rows. The penalty is chosen by mean daily rank IC on
    the validation rows (the same purged year LightGBM uses for early stopping); the test rows are only
    predicted. Training labels are ranked per date and centred, like LightGBM's CSRankNorm."""
    train, valid, test = (np.asarray(m, dtype=bool) for m in (train, valid, test))
    tr = train & label.notna().values
    va = valid & label.notna().values
    y = (label[tr].groupby(level=0).rank(pct=True) - 0.5).values
    A = Xr.values
    scores = {}
    weights = {}
    for a in alphas:
        w = ridge_fit(A[tr], y, a)
        weights[a] = w
        pv = pd.Series(A[va] @ w, index=Xr.index[va])
        ic = daily_ic(pv, label[va], min_names)
        scores[a] = float(ic.mean()) if len(ic) else float("nan")
    ok = {a: v for a, v in scores.items() if np.isfinite(v)}
    best = max(ok, key=lambda a: (ok[a], a)) if ok else max(alphas)  # ties -> stronger penalty
    pred = pd.Series(A[test] @ weights[best], index=Xr.index[test])
    return {"pred": pred, "alpha": float(best), "valid_ic": {str(a): v for a, v in scores.items()},
            "weights": dict(zip(Xr.columns, weights[best].round(6).tolist()))}


# ---------------------------------------------------------------------------
# Hyperparameter tuning for the walk-forward LightGBM (opt-in, cheap, validation years only)
# ---------------------------------------------------------------------------
# Search: Latin-hypercube random search (Bergstra & Bengio 2012) with successive halving (the core of
# Hyperband, Li et al. 2018): every config is scored on a few folds, the best third goes on to all folds.
# Score: mean daily rank IC on each fold's purged VALIDATION year (never a test year, never the holdout).
# Check: CSCV probability of backtest overfitting (Bailey, Borwein, López de Prado & Zhu 2017) over folds.

TUNE_SPACE = {  # name: (scale, low, high); "log" = uniform in log space, "int" = log-spaced integers, "lin" = linear
    "learning_rate": ("log", 0.01, 0.1),
    "num_leaves": ("int", 4, 32),
    "max_depth": ("int", 2, 6),
    "min_child_samples": ("int", 20, 300),
    "lambda_l1": ("log", 1e-3, 10.0),
    "lambda_l2": ("log", 1e-3, 10.0),
    "colsample_bytree": ("lin", 0.5, 0.9),
    "subsample": ("lin", 0.5, 0.9),
}
TUNE_MAX_TRIALS = 30


def lhs_configs(space: dict, n: int, seed: int, base: dict) -> list:
    """n configs: the first is `base` (the fixed defaults), the rest a Latin hypercube over `space`
    (each parameter's range cut into n-1 equal strata, one point per stratum, shuffled)."""
    rng = np.random.default_rng(seed)
    out = [{k: base[k] for k in space}]
    m = max(n - 1, 0)
    if m == 0:
        return out
    cols = {}
    for k in space:
        u = (rng.permutation(m) + rng.random(m)) / m
        kind, lo, hi = space[k]
        if kind == "lin":
            v = lo + (hi - lo) * u
            cols[k] = [round(float(x), 3) for x in v]
        else:
            v = np.exp(np.log(lo) + (np.log(hi) - np.log(lo)) * u)
            cols[k] = [int(round(x)) for x in v] if kind == "int" else [float(f"{x:.4g}") for x in v]
    for i in range(m):
        out.append({k: cols[k][i] for k in space})
    return out


def halving_folds(fold_names: list, first: int = 3) -> list:
    """Folds used in the first rung: `first` folds spread over time (earliest, middle, latest), so a
    config is not promoted for suiting one market regime."""
    n = len(fold_names)
    if n <= first:
        return list(fold_names)
    idx = sorted({int(round(i * (n - 1) / (first - 1))) for i in range(first)})
    return [fold_names[i] for i in idx]


def promote(scores: dict, keep: int, always: str = "c0") -> list:
    """Ids of the `keep` best configs by mean score (plus `always`, the defaults, for comparison)."""
    ranked = sorted(scores, key=lambda c: (-np.nanmean(list(scores[c].values())) if scores[c] else np.inf, c))
    out = ranked[:keep]
    if always in scores and always not in out:
        out.append(always)
    return out


def cscv_pbo(perf: np.ndarray, max_blocks: int = 10):
    """Probability of backtest overfitting by combinatorially symmetric cross-validation.
    perf: blocks x configs (here: one row per fold, the config's mean validation IC in that fold).
    For every way of splitting an even number of blocks into halves, the config best on one half is
    ranked on the other; PBO = share of splits where it lands at or below the median."""
    perf = np.asarray(perf, dtype="float64")
    S, N = perf.shape
    S = min(S - S % 2, max_blocks)
    if N < 4 or S < 4:
        return None
    perf = perf[-S:]  # most recent S blocks
    from itertools import combinations
    below, n, pairs = 0, 0, []
    for ins in combinations(range(S), S // 2):
        oos = [b for b in range(S) if b not in ins]
        r_in = np.nanmean(perf[list(ins)], axis=0)
        r_out = np.nanmean(perf[oos], axis=0)
        best = int(np.nanargmax(r_in))
        rank = (r_out < r_out[best]).sum() + ((r_out == r_out[best]).sum() + 1) / 2
        w = rank / (N + 1)
        below += np.log(w / (1 - w)) <= 0
        pairs.append((r_in[best], r_out[best]))
        n += 1
    return {"pbo": float(below / n), "combos": n, "blocks": int(S), "configs": int(N),
            "mean_oos_of_best": float(np.mean([p[1] for p in pairs]))}


def tune_select(scores: dict, pbo, default_id: str = "c0", min_gain: float = 0.002) -> dict:
    """Fixed rule: keep the defaults unless the best config's mean validation IC beats them by at
    least `min_gain` (an absolute daily-IC margin) AND PBO <= 0.5."""
    mean = {c: float(np.nanmean(list(v.values()))) for c, v in scores.items() if v}
    best = max(mean, key=lambda c: (mean[c], c == default_id))
    d = mean.get(default_id, float("nan"))
    if pbo is not None and pbo["pbo"] > 0.5:
        return {"chosen": default_id, "reason": f"PBO = {pbo['pbo']:.2f} > 0.5: the best config on some folds is below the median on the others. Kept the fixed defaults.", "best": best, "mean_valid_ic": mean}
    if best == default_id or not np.isfinite(d) or mean[best] - d < min_gain:
        return {"chosen": default_id, "reason": f"No config beat the defaults by at least {min_gain} mean validation IC. Kept the fixed defaults.", "best": best, "mean_valid_ic": mean}
    if pbo is None:
        return {"chosen": default_id, "reason": "Too few folds or configs to estimate PBO, so the gain cannot be checked. Kept the fixed defaults.", "best": best, "mean_valid_ic": mean}
    return {"chosen": best, "reason": f"Config {best} beat the defaults by {mean[best] - d:+.4f} mean validation IC with PBO = {pbo['pbo']:.2f}.", "best": best, "mean_valid_ic": mean}


def ic_difference(ic_a: pd.Series, ic_b: pd.Series, h: int) -> dict:
    """Paired comparison of two daily IC series on their common dates (a minus b), summarised like
    ic_summary (non-overlapping t-stat)."""
    common = ic_a.index.intersection(ic_b.index)
    return ic_summary((ic_a.loc[common] - ic_b.loc[common]).dropna(), h)


def ic_summary(ic: pd.Series, h: int) -> dict:
    if len(ic) == 0:
        return {"mean_ic": float("nan"), "icir": float("nan"), "t_nonoverlap": float("nan"), "n_days": 0}
    no = ic.iloc[::max(h, 1)]  # non-overlapping sample for honest t-stat
    t = no.mean() / (no.std() / math.sqrt(len(no))) if len(no) > 2 and no.std() > 0 else float("nan")
    return {"mean_ic": float(ic.mean()), "icir": float(ic.mean() / ic.std()) if ic.std() > 0 else float("nan"),
            "t_nonoverlap": float(t), "n_days": int(len(ic)), "n_nonoverlap": int(len(no)),
            "pct_positive": float((ic > 0).mean())}


def block_bootstrap_sharpe(returns: pd.Series, n: int = 1000, block: int = 20, seed: int = 0) -> dict:
    r = returns.dropna().values
    if len(r) < block * 2:
        return {"lo": float("nan"), "hi": float("nan"), "p_le_0": float("nan")}
    rng = np.random.default_rng(seed)
    nb = int(math.ceil(len(r) / block))
    out = []
    for _ in range(n):
        # Circular blocks (as lib/stats.mjs): without wrap-around the first/last ~block days are almost never drawn,
        # under-weighting a losing streak at the end of the holdout
        idx = ((rng.integers(0, len(r), nb)[:, None] + np.arange(block)) % len(r)).ravel()[: len(r)]
        x = r[idx]
        s = x.std(ddof=1)
        out.append(x.mean() / s * math.sqrt(252) if s > 0 else 0.0)
    out = np.array(out)
    return {"lo": float(np.percentile(out, 2.5)), "hi": float(np.percentile(out, 97.5)),
            "p_le_0": float((out <= 0).mean())}


# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------

def verdict(dev: dict, hold: dict | None) -> dict:
    """Rule-based verdict. All thresholds are fixed here, before any holdout run.

    dev keys: ic_t (non-overlap t-stat of walk-forward IC), perm_p (permutation
      p-value; None = control not run, which fails the gate), sharpe_net, ew_sharpe,
      random_p95_sharpe, momentum_sharpe (optional), model (optional label for messages)
    hold keys: ic_mean, excess_vs_ew (ann. arithmetic), sharpe_net, sharpe_ci_lo,
      random_p95_sharpe
    """
    reasons, passed = [], []
    def gate(ok, msg):
        (passed if ok else reasons).append(msg)
    who = f" ({dev['model']})" if dev.get("model") else ""
    gate(dev["ic_t"] > 2.0, f"walk-forward IC t-stat{who} {dev['ic_t']:.2f} (need > 2.0)")
    if dev.get("perm_p") is None:
        gate(False, f"permutation control{who} not run (need p < 0.05)")
    else:
        gate(dev["perm_p"] < 0.05, f"permutation p-value{who} {dev['perm_p']:.3f} (need < 0.05)")
    gate(dev["sharpe_net"] > dev["ew_sharpe"], f"dev net Sharpe {dev['sharpe_net']:.2f} vs equal-weight universe {dev['ew_sharpe']:.2f}")
    gate(dev["sharpe_net"] > dev["random_p95_sharpe"], f"dev net Sharpe {dev['sharpe_net']:.2f} vs random top-K 95th pct {dev['random_p95_sharpe']:.2f}")
    if "momentum_sharpe" in dev:
        gate(dev["sharpe_net"] > dev["momentum_sharpe"], f"dev net Sharpe {dev['sharpe_net']:.2f} vs simple momentum top-K {dev['momentum_sharpe']:.2f}")
    dev_ok = not reasons
    if hold is not None:
        gate(hold["ic_mean"] > 0, f"holdout mean IC {hold['ic_mean']:+.4f} (need > 0)")
        gate(hold["excess_vs_ew"] > 0, f"holdout excess vs equal-weight {hold['excess_vs_ew']:+.2%} (need > 0)")
        gate(hold["sharpe_ci_lo"] > 0, f"holdout Sharpe 95% CI lower bound {hold['sharpe_ci_lo']:.2f} (need > 0)")
        gate(hold["sharpe_net"] > hold["random_p95_sharpe"], f"holdout Sharpe {hold['sharpe_net']:.2f} vs random top-K 95th pct {hold['random_p95_sharpe']:.2f}")
    if not reasons:
        label = "CANDIDATE STRATEGY (paper-trade before any real capital)"
    elif dev_ok:
        label = "INCONCLUSIVE: development evidence did not survive the holdout"
    else:
        label = "NO RELIABLE STRATEGY FOUND"
    return {"verdict": label, "failed": reasons, "passed": passed}


# ---------------------------------------------------------------------------
# Small IO helpers
# ---------------------------------------------------------------------------

def atomic_write_text(path, text: str):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp_")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def atomic_write_json(path, obj):
    atomic_write_text(path, json.dumps(obj, indent=2, default=_json_default))


def atomic_pickle(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp_")
    os.close(fd)
    pd.to_pickle(obj, tmp)
    os.replace(tmp, path)


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, (pd.Timestamp,)):
        return str(o.date())
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, Fold):
        return asdict(o)
    return str(o)
