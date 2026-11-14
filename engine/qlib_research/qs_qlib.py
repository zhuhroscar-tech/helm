"""Qlib-native execution and evaluation for the quant-strategy pipeline.

Every backtest runs through Qlib's own engine (`qlib.backtest.backtest` with a
`SimulatorExecutor`, Qlib's `Exchange` and `Account`). The strategy is a subclass of Qlib's
`WeightStrategyBase`: on each trading day Qlib hands it the previous trading day (the signal
date); if that day is a rebalance date the strategy returns the target weights decided from
the signal, and Qlib's `OrderGenWOInteract` turns them into orders sized with the signal-date
close, filled at the trading day's OPEN (`deal_price="open"`), with costs on traded value.
Between rebalances it returns nothing, so holdings drift. Metrics use
`qlib.contrib.evaluate.risk_analysis`; IC uses `qlib.contrib.eva.alpha.calc_ic`.
"""
from __future__ import annotations

import contextlib
import copy
import io
from pathlib import Path

import numpy as np
import pandas as pd

from qlib.backtest import backtest as q_backtest
from qlib.backtest.decision import TradeDecisionWO
from qlib.contrib.evaluate import risk_analysis
from qlib.contrib.eva.alpha import calc_all_ic, calc_ic, calc_long_short_return
from qlib.contrib.strategy.signal_strategy import WeightStrategyBase
from qlib.data.dataset.processor import Processor

INITIAL = 1e8


class TargetWeightStrategy(WeightStrategyBase):
    """Executes pre-decided target weights {signal_date: pd.Series(weights)} in Qlib.

    The weights' sum is the invested share (risk degree); the rest stays in cash.
    Qlib cannot trade a stock after its last price (merger, delisting), so such a holding would
    sit in the account as dead capital forever. `data_end` ({stock: last priced day}) lets the
    strategy convert it to cash at its last price, less the closing cost, on the next trading day
    (true delisting proceeds are unknown)."""

    def __init__(self, targets: dict, data_end: dict | None = None, close_cost: float = 0.0, **kwargs):
        idx = pd.MultiIndex.from_tuples([(pd.Timestamp("1990-01-01"), "_")], names=["datetime", "instrument"])
        super().__init__(signal=pd.Series([0.0], index=idx), **kwargs)  # signal is unused; targets carry the decision
        self.targets = {pd.Timestamp(d): w for d, w in targets.items()}
        self.data_end, self.close_cost = data_end or {}, close_cost
        self.delisting_sales = []

    def _liquidate_ended(self, t0):
        pos = self.trade_position
        for s in list(pos.get_stock_list()):
            end = self.data_end.get(s)
            if end is not None and end < t0:
                val = pos.get_stock_amount(s) * pos.get_stock_price(s)
                pos.position["cash"] += val * (1 - self.close_cost)
                pos._del_stock(s)
                self.delisting_sales.append((t0, s, val))

    def generate_trade_decision(self, execute_result=None):
        step = self.trade_calendar.get_trade_step()
        t0, t1 = self.trade_calendar.get_step_time(step)
        p0, p1 = self.trade_calendar.get_step_time(step, shift=1)
        self._liquidate_ended(pd.Timestamp(t0))
        w = self.targets.get(pd.Timestamp(p0).normalize())
        if w is None or len(w) == 0:
            return TradeDecisionWO([], self)
        w = w[w > 0]
        invested = float(w.sum())
        current = copy.deepcopy(self.trade_position)
        orders = self.order_generator.generate_order_list_from_target_weight_position(
            current=current, trade_exchange=self.trade_exchange, risk_degree=invested,
            target_weight_position=(w / invested).to_dict(), pred_start_time=p0, pred_end_time=p1,
            trade_start_time=t0, trade_end_time=t1)
        return TradeDecisionWO(orders, self)


def run_backtest(targets: dict, start, end, cost_bps: float, codes: list, benchmark: str | None = None,
                 data_end: dict | None = None, return_positions: bool = False):
    """Qlib backtest of target weights. Returns a daily frame like qs_core.simulate:
    nav (start = 1), traded, cost, exposure (share of NAV in stocks), cash."""
    from qlib.data import D
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    cal = D.calendar(freq="day")
    end = min(end, pd.Timestamp(cal[-2]))  # Qlib needs the next calendar day to close the last step
    exch = {"freq": "day", "codes": codes, "deal_price": "open", "open_cost": cost_bps / 1e4,
            "close_cost": cost_bps / 1e4, "min_cost": 0.0, "limit_threshold": None, "trade_unit": None}
    strategy = TargetWeightStrategy(targets, data_end=data_end, close_cost=cost_bps / 1e4)
    executor = {"class": "SimulatorExecutor", "module_path": "qlib.backtest.executor",
                "kwargs": {"time_per_step": "day", "generate_portfolio_metrics": True, "verbose": False}}
    pm, _ = q_backtest(start_time=start, end_time=end, strategy=strategy, executor=executor,
                       benchmark=benchmark or codes[0], account=INITIAL, exchange_kwargs=exch)
    rep = pm["1day"][0]
    acct = rep["account"]
    out = pd.DataFrame({"nav": acct / INITIAL, "traded": rep["total_turnover"].diff().fillna(rep["total_turnover"]) / INITIAL,
                        "cost": rep["total_cost"].diff().fillna(rep["total_cost"]) / INITIAL,
                        "exposure": (rep["value"] / acct).fillna(0.0), "cash": rep["cash"] / INITIAL,
                        "bench": rep["bench"]})
    out.index = pd.DatetimeIndex(out.index)
    if return_positions:  # {date: {stock: shares held at that day's close}} from Qlib's position history
        pos = {pd.Timestamp(d): {s: p.get_stock_amount(s) for s in p.get_stock_list()} for d, p in pm["1day"][1].items()}
        return out, pos
    return out


US_DAYS = 252  # risk_analysis defaults to 238 (China); US markets trade ~252 days


def perf(nav: pd.Series) -> dict:
    """Performance from Qlib's risk_analysis: CAGR and max drawdown in 'product' mode (compounded),
    Sharpe = information ratio of daily returns (rf = 0) and volatility in 'sum' mode."""
    nav = nav.dropna()
    r = nav.pct_change().dropna()
    if len(r) < 5:
        return {}
    geo = risk_analysis(r, N=US_DAYS, freq=None, mode="product")["risk"]
    ari = risk_analysis(r, N=US_DAYS, freq=None, mode="sum")["risk"]
    # From the NAV itself: qlib's product-mode drawdown starts at (1+r1), so a loss on the first day is never counted
    mdd = float((nav / nav.cummax() - 1).min())
    cagr = float(geo["annualized_return"])
    return {"total_return": float(nav.iloc[-1] / nav.iloc[0] - 1), "cagr": cagr,
            "ann_vol": float(ari["std"] * np.sqrt(US_DAYS)), "sharpe": float(ari["information_ratio"]),
            "max_drawdown": mdd, "calmar": float(cagr / abs(mdd)) if mdd < 0 else float("nan"),
            "start": str(nav.index[0].date()), "end": str(nav.index[-1].date()), "days": int(len(r)),
            "metrics_source": "qlib.contrib.evaluate.risk_analysis (N=252)"}


def sim_stats(sim: pd.DataFrame) -> dict:
    out = perf(sim["nav"])
    yrs = max(len(sim) / US_DAYS, 1e-9)
    out["annual_turnover"] = float((sim["traded"] / sim["nav"]).sum() / yrs)
    out["total_cost_pct_of_initial"] = float(sim["cost"].sum())
    out["avg_exposure"] = float(sim["exposure"].mean())
    return out


def excess(nav: pd.Series, bench: pd.Series) -> dict:
    """Qlib's standard excess-return analysis: risk_analysis of (strategy - benchmark) daily returns."""
    a = pd.concat([nav, bench], axis=1).dropna()
    r = a.pct_change().dropna()
    ex = r.iloc[:, 0] - r.iloc[:, 1]
    ra = risk_analysis(ex, N=US_DAYS, freq=None, mode="sum")["risk"]
    return {"ann_excess_arith": float(ra["annualized_return"]), "tracking_error": float(ra["std"] * np.sqrt(US_DAYS)),
            "information_ratio": float(ra["information_ratio"]),
            "total_return_diff": float(a.iloc[-1, 0] / a.iloc[0, 0] - a.iloc[-1, 1] / a.iloc[0, 1])}


def qlib_ic(pred: pd.Series, label: pd.Series, min_names: int = 5) -> pd.Series:
    """Daily rank IC from Qlib's calc_ic (dates with fewer than min_names pairs dropped)."""
    df = pd.concat({"p": pred, "l": label}, axis=1).dropna()
    n = df.groupby(level=0).size()
    df = df[df.index.get_level_values(0).isin(n[n >= min_names].index)]
    _, ric = calc_ic(df["p"], df["l"])
    return ric.dropna()


def _min_names(df, min_names):
    n = df.groupby(level=0).size()
    return df[df.index.get_level_values(0).isin(n[n >= min_names].index)]


def factor_rank_ic(X: pd.DataFrame, label: pd.Series, min_names: int = 5) -> pd.DataFrame:
    """Daily rank IC of every column of X with Qlib's calc_all_ic (calc_ic per factor, in parallel).
    Returns dates x factors."""
    df = _min_names(pd.concat([X, label.rename("__label__")], axis=1).dropna(subset=["__label__"]), min_names)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        res = calc_all_ic({c: df[c] for c in X.columns}, df["__label__"], n_jobs=-1)
    return pd.DataFrame({c: res[c]["ric"] for c in X.columns})


def signal_analysis(pred: pd.Series, label: pd.Series, raw_return: pd.Series, h: int, min_names: int = 5) -> dict:
    """The metrics of Qlib's SigAnaRecord (IC, ICIR, Rank IC, Rank ICIR, long-short and long-average
    returns from calc_long_short_return on raw returns, top/bottom 20%), annualised for h-day labels
    (ann_scaler = 252 / h)."""
    df = _min_names(pd.concat({"p": pred, "l": label, "r": raw_return}, axis=1).dropna(), min_names)
    ic, ric = calc_ic(df["p"], df["l"])
    ls, la = calc_long_short_return(df["p"], df["r"])
    sc = US_DAYS / max(h, 1)
    return {"IC": float(ic.mean()), "ICIR": float(ic.mean() / ic.std()), "Rank IC": float(ric.mean()),
            "Rank ICIR": float(ric.mean() / ric.std()),
            "Long-Short Ann Return": float(ls.mean() * sc), "Long-Short Ann Sharpe": float(ls.mean() / ls.std() * sc ** 0.5),
            "Long-Avg Ann Return": float(la.mean() * sc), "Long-Avg Ann Sharpe": float(la.mean() / la.std() * sc ** 0.5),
            "source": "qlib.contrib.eva.alpha.calc_ic / calc_long_short_return (SigAnaRecord metrics); "
                      f"ann_scaler 252/{h}; overlapping {h}-day labels, so Sharpe-type ratios are optimistic"}


# ---------------------------------------------------------------------------
# Qlib processors used by the pipeline
# ---------------------------------------------------------------------------

def _label_cols(df):
    if isinstance(df.columns, pd.MultiIndex):
        return [c for c in df.columns if c[0] == "label"]
    return list(df.columns)


class SectorDemean(Processor):
    """Qlib processor: label minus its (date, sector) mean, i.e. the return relative to the stock's
    own sector that day (sector-neutral learning target)."""

    def __init__(self, sectors: dict):
        self.sectors = sectors

    def __call__(self, df):
        df = df.copy()
        sec = df.index.get_level_values("instrument").map(lambda t: self.sectors.get(t, "Unknown"))
        keys = [df.index.get_level_values("datetime"), sec]
        for c in _label_cols(df):
            df[c] = df[c] - df[c].groupby(keys).transform("mean")
        return df

    def is_for_infer(self) -> bool:
        return False


class ShuffleLabelWithinDate(Processor):
    """Qlib processor for the permutation control: shuffles labels across stocks within each date
    on or before `until` (the training window), keeping dates and the validation labels intact."""

    def __init__(self, seed: int, until):
        self.seed, self.until = seed, pd.Timestamp(until)

    def __call__(self, df):
        df = df.copy()
        rng = np.random.default_rng(self.seed)
        d = df.index.get_level_values("datetime")
        for c in _label_cols(df):
            v = df[c].values.copy()
            pos = pd.Series(np.arange(len(df)), index=d)
            for _, idx in pos[pos.index <= self.until].groupby(level=0):
                ii = idx.values
                v[ii] = v[rng.permutation(ii)]
            df[c] = v
        return df

    def is_for_infer(self) -> bool:
        return False


# ---------------------------------------------------------------------------
# Model: Qlib's LGBModel on a Qlib DatasetH
# ---------------------------------------------------------------------------

def lgb_fit_predict(X: pd.DataFrame, label: pd.Series, segments: dict, params: dict, seeds: list,
                    shuffle_seed: int | None = None):
    """Fit qlib.contrib.model.gbdt.LGBModel per seed on a DatasetH built from (X, label) and
    predict the test segment. Learning processors: DropnaLabel -> [shuffle] -> CSRankNorm(label).
    Returns (DataFrame of per-seed predictions, best iterations)."""
    from qlib.contrib.model.gbdt import LGBModel
    from qlib.data.dataset import DatasetH
    from qlib.data.dataset.handler import DataHandlerLP
    from qlib.data.dataset.loader import StaticDataLoader
    from qlib.data.dataset.processor import CSRankNorm, DropnaLabel

    df = pd.concat({"feature": X, "label": label.rename("LABEL").to_frame()}, axis=1)
    df.index.names = ["datetime", "instrument"]
    learn = [DropnaLabel()]
    if shuffle_seed is not None:
        learn.append(ShuffleLabelWithinDate(shuffle_seed, segments["train"][1]))
    learn.append(CSRankNorm(fields_group="label"))
    handler = DataHandlerLP(data_loader=StaticDataLoader(config=df), infer_processors=[], learn_processors=learn)
    ds = DatasetH(handler, segments={k: (pd.Timestamp(a), pd.Timestamp(b)) for k, (a, b) in segments.items()})
    p = {k: v for k, v in params.items() if k != "objective"}
    preds, iters = {}, []
    for s in seeds:
        m = LGBModel(loss="mse", early_stopping_rounds=50, num_boost_round=1000, **{**p, "seed": s})
        with contextlib.redirect_stdout(io.StringIO()):  # Qlib's early-stopping callback prints every fit
            m.fit(ds, verbose_eval=0)
        iters.append(int(m.model.best_iteration))
        preds[s] = m.predict(ds, segment="test")
    return pd.DataFrame(preds), iters


# ---------------------------------------------------------------------------
# Provider writers (Qlib binary layout)
# ---------------------------------------------------------------------------

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
