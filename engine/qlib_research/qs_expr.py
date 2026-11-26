"""Qlib-free evaluator for Helm's factor formulas (step 1 of notes/qlib-swap-plan.md).

Evaluates the AST from qs_idea.parse_expr over a Qlib-layout data directory (calendars/day.txt,
features/<ticker>/<field>.day.bin), without importing qlib. It reproduces qlib 0.9.7's results:

- Per ticker, on that ticker's own data span only (qlib's file storage trims to the span), with the
  same pandas / numpy calls qlib makes, so dtypes and their quirks match: raw fields are float32;
  comparisons give bool; numpy adds two bools as OR; Not only works on bools; If uses np.where.
- Windows: min_periods=1 everywhere; window 0 = expanding; EMA window in (0,1) = alpha.
- Slope / Rsquare / Resi: the same window maths as qlib's Cython code (NaN slots count towards the
  window; x = position in the window).
- Start date (qlib_compat=True, the default): qlib loads each ticker only from (start - lookback),
  where lookback follows qlib's rules (and is 0 for window-0 operators). So expanding operators,
  Ref(x,0), Delta(x,0) and EMA depend on the start date. qlib_compat=False uses the full history.
- Output: float32 per ticker (as qlib casts), then float64 with +-inf -> NaN (as qs_idea did).

Deliberate differences: unary minus works (qlib raises on it), and Corr/Cov with window 0 are
rejected with a clear message (qlib fails with "Invalid index range").
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

ROLL_FUNCS = {"Mean": "mean", "Sum": "sum", "Std": "std", "Var": "var", "Skew": "skew", "Kurt": "kurt",
              "Max": "max", "Min": "min", "Med": "median", "Count": "count"}
BIN_FUNCS = {"+": "add", "-": "subtract", "*": "multiply", "/": "divide", ">": "greater", ">=": "greater_equal",
             "<": "less", "<=": "less_equal", "==": "equal", "!=": "not_equal", "&": "bitwise_and", "|": "bitwise_or"}
PAIR_FUNCS = {"Power": "power", "Greater": "maximum", "Less": "minimum", "Gt": "greater", "Ge": "greater_equal",
              "Lt": "less", "Le": "less_equal", "Eq": "equal", "Ne": "not_equal", "And": "bitwise_and",
              "Or": "bitwise_or"}
ELEM_FUNCS = {"Abs": "abs", "Log": "log", "Not": "bitwise_not"}
_PY_BIN = {"+": lambda a, b: a + b, "-": lambda a, b: a - b, "*": lambda a, b: a * b, "/": lambda a, b: a / b,
           ">": lambda a, b: a > b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, "<=": lambda a, b: a <= b,
           "==": lambda a, b: a == b, "!=": lambda a, b: a != b, "&": lambda a, b: a & b, "|": lambda a, b: a | b}


def _err(msg):
    from qs_idea import IdeaError  # lazy: qs_idea imports this module
    return IdeaError(msg)


def _num(v):
    """qlib reads literals from the formula text: 20 is an int, 0.5 a float."""
    return int(v) if float(v).is_integer() else float(v)


# ---------------------------------------------------------------------------
# Data: Qlib binary layout, read directly
# ---------------------------------------------------------------------------

class BinData:
    """Read-only view of a Qlib-layout directory. field(t, f) -> float32 Series indexed by calendar position."""

    def __init__(self, uri):
        self.uri = Path(uri)
        self.calendar = pd.DatetimeIndex(pd.read_csv(self.uri / "calendars" / "day.txt", header=None)[0])
        self._cache: dict = {}

    def field(self, ticker: str, field: str) -> pd.Series:
        key = (ticker.lower(), field)
        if key not in self._cache:
            p = self.uri / "features" / ticker.lower() / f"{field}.day.bin"
            if p.exists():
                raw = np.fromfile(p, dtype="<f4")
                si = int(raw[0])
                s = pd.Series(raw[1:], index=pd.RangeIndex(si, si + len(raw) - 1))
            else:
                s = pd.Series([], dtype="float32", index=pd.RangeIndex(0, 0))
            self._cache[key] = s
        return self._cache[key]


# ---------------------------------------------------------------------------
# Lookback (qlib's get_extended_window_size, left side only: formulas never look forward)
# ---------------------------------------------------------------------------

def lookback(node) -> float:
    kind = node[0]
    if kind in ("num", "feat"):
        return 0
    if kind == "neg":
        return lookback(node[1])
    if kind == "bin":
        return max(lookback(node[2]), lookback(node[3]))
    op, args = node[1], node[2]
    if op in ("Corr", "Cov"):
        n = _num(args[2][1])
        if n == 0:
            raise _err(f"{op} 的窗口不能是 0（qlib 也算不了）；请写一个具体的天数，比如 {op}(a, b, 60)")
        return max(lookback(args[0]), lookback(args[1])) + n - 1
    if op in ROLL_FUNCS or op in ("Ref", "Delta", "Slope", "Rsquare", "Resi", "Rank", "IdxMax", "IdxMin", "Quantile",
                                  "Mad", "WMA", "EMA"):
        child, n = lookback(args[0]), _num(args[1][1])
        if n == 0:
            return child
        if op == "Ref":
            return child + n
        if 0 < n < 1:
            return max(child + int(np.log(1e-6) / np.log(1 - n)) - 1, child)
        return max(child + n - 1, child)
    return max((lookback(a) for a in args), default=0)  # element-wise, pair, If


# ---------------------------------------------------------------------------
# Operators (each mirrors the qlib class of the same name)
# ---------------------------------------------------------------------------

def _rolling(s, n, func):
    if isinstance(n, int) and n == 0:
        return getattr(s.expanding(min_periods=1), func)()
    if isinstance(n, float) and 0 < n < 1:
        return s.ewm(alpha=n, min_periods=1).mean()
    return getattr(s.rolling(n, min_periods=1), func)()


def _window(s, n):
    return s.expanding(min_periods=1) if n == 0 else s.rolling(n, min_periods=1)


def _mad(x):
    x1 = x[~np.isnan(x)]
    return np.mean(np.abs(x1 - x1.mean()))


def _wma(x):
    w = np.arange(len(x)) + 1
    w = w / w.sum()
    return np.nanmean(w * x)


def _ewm_expanding(x):
    a = 1 - 2 / (1 + len(x))
    w = a ** np.arange(len(x))[::-1]
    w /= w.sum()
    return np.nansum(w * x)


def _regression(s: pd.Series, n: int, what: str) -> pd.Series:
    """qlib's Cython rolling/expanding slope, rsquare and resi. NaN slots count towards the window but not
    the fit; x = 1..window inside a rolling window (newest = window), x = 1..size when expanding."""
    y = s.to_numpy(dtype="float64")
    m = len(y)
    if m == 0:
        return pd.Series([], dtype="float64", index=s.index)
    with np.errstate(all="ignore"):
        if n == 0:
            x = np.arange(1, m + 1, dtype="float64")
            ok = ~np.isnan(y)
            yv, xv = np.where(ok, y, 0.0), np.where(ok, x, 0.0)
            N = np.cumsum(ok)
            sx, sxx, sy = np.cumsum(xv), np.cumsum(xv * xv), np.cumsum(yv)
            syy, sxy = np.cumsum(yv * yv), np.cumsum(xv * yv)
            x_last = x
        else:
            yp = np.concatenate([np.full(n - 1, np.nan), y])
            win = sliding_window_view(yp, n)  # m x n, oldest first
            ok = ~np.isnan(win)
            x = np.arange(1, n + 1, dtype="float64")
            yv, xv = np.where(ok, win, 0.0), np.where(ok, x, 0.0)
            N = ok.sum(axis=1)
            sx, sxx, sy = xv.sum(axis=1), (xv * xv).sum(axis=1), yv.sum(axis=1)
            syy, sxy = (yv * yv).sum(axis=1), (xv * yv).sum(axis=1)
            x_last = float(n)
        num = N * sxy - sx * sy
        if what == "slope":
            out = num / (N * sxx - sx * sx)
        elif what == "resi":
            slope = num / (N * sxx - sx * sx)
            out = y - (slope * x_last + (sy / N - slope * sx / N))
        else:
            r = num / np.sqrt((N * sxx - sx * sx) * (N * syy - sy * sy))
            out = r * r
    res = pd.Series(out, index=s.index)
    if what == "rsquare" and n != 0:
        res.loc[np.isclose(s.rolling(n, min_periods=1).std(), 0, atol=2e-05)] = np.nan
    return res


def _call(op, args, ev):
    if op in ROLL_FUNCS:
        return _rolling(ev(args[0]), _num(args[1][1]), ROLL_FUNCS[op])
    if op == "Ref":
        s, n = ev(args[0]), _num(args[1][1])
        if s.empty:
            return s
        return pd.Series(s.iloc[0], index=s.index) if n == 0 else s.shift(n)
    if op == "Delta":
        s, n = ev(args[0]), _num(args[1][1])
        if s.empty:
            return s
        return s - s.iloc[0] if n == 0 else s - s.shift(n)
    if op in ("IdxMax", "IdxMin"):
        s, n = ev(args[0]), _num(args[1][1])
        f = (lambda x: x.argmax() + 1) if op == "IdxMax" else (lambda x: x.argmin() + 1)
        return _window(s, n).apply(f, raw=True)
    if op == "Quantile":
        s, n, q = ev(args[0]), _num(args[1][1]), args[2][1]
        return _window(s, n).quantile(q)
    if op == "Mad":
        return _window(ev(args[0]), _num(args[1][1])).apply(_mad, raw=True)
    if op == "Rank":
        return _window(ev(args[0]), _num(args[1][1])).rank(pct=True)
    if op == "WMA":
        return _window(ev(args[0]), _num(args[1][1])).apply(_wma, raw=True)
    if op == "EMA":
        s, n = ev(args[0]), _num(args[1][1])
        if n == 0:
            return s.expanding(min_periods=1).apply(_ewm_expanding, raw=True)
        if 0 < n < 1:
            return s.ewm(alpha=n, min_periods=1).mean()
        return s.ewm(span=n, min_periods=1).mean()
    if op in ("Slope", "Rsquare", "Resi"):
        return _regression(ev(args[0]), _num(args[1][1]), op.lower())
    if op in ("Corr", "Cov"):
        a, b, n = ev(args[0]), ev(args[1]), _num(args[2][1])
        if n == 0:
            raise _err(f"{op} 的窗口不能是 0（qlib 也算不了）；请写一个具体的天数，比如 {op}(a, b, 60)")
        res = getattr(a.rolling(n, min_periods=1), op.lower())(b)
        if op == "Corr":
            res.loc[np.isclose(a.rolling(n, min_periods=1).std(), 0, atol=2e-05)
                    | np.isclose(b.rolling(n, min_periods=1).std(), 0, atol=2e-05)] = np.nan
        return res
    if op == "Sign":
        return np.sign(ev(args[0]).astype(np.float32))
    if op in ELEM_FUNCS:
        s = ev(args[0])
        try:
            return getattr(np, ELEM_FUNCS[op])(s)
        except TypeError:
            raise _err(f"{op} 只能用在比较的结果上（比如 Not(Gt($close,$open))），不能直接用在数值上") from None
    if op in PAIR_FUNCS:
        a, b = ev(args[0]), ev(args[1])
        try:
            return getattr(np, PAIR_FUNCS[op])(a, b)
        except TypeError:
            raise _err(f"{op} 的两个参数类型不对：And / Or 只能连接比较的结果") from None
    if op == "If":
        c, a, b = ev(args[0]), ev(args[1]), ev(args[2])
        if not isinstance(c, pd.Series):
            raise _err("If 的第一个参数应该是一个比较，比如 If(Gt($close,$open), 1, 0)")
        return pd.Series(np.where(c, a, b), index=c.index)
    raise _err(f"不支持的运算符 {op}")


def evaluate(node, field):
    """Evaluate an AST for one ticker. field(name) -> that ticker's float32 Series (calendar positions)."""
    def ev(nd):
        kind = nd[0]
        if kind == "num":
            return _num(nd[1])
        if kind == "feat":
            return field(nd[1])
        if kind == "neg":
            return np.negative(ev(nd[1]))
        if kind == "bin":
            a, b = ev(nd[2]), ev(nd[3])
            if not isinstance(a, pd.Series) and not isinstance(b, pd.Series):
                return _PY_BIN[nd[1]](a, b)
            try:
                return getattr(np, BIN_FUNCS[nd[1]])(a, b)
            except TypeError:
                raise _err(f"{nd[1]} 两边的类型不对：& 和 | 只能连接比较的结果") from None
        return _call(nd[1], nd[2], ev)
    return ev(node)


# ---------------------------------------------------------------------------
# Entry point: the drop-in replacement for qs_idea.qlib_expr_wide
# ---------------------------------------------------------------------------

def expr_wide(expr: str, instruments: list, start, end, data: BinData, qlib_compat: bool = True) -> pd.DataFrame:
    """dates x tickers (float64) for a validated formula, from start to end (None = last date)."""
    w = expr_wide_f32(expr, instruments, start, end, data, qlib_compat)
    out = w.astype("float64").replace([np.inf, -np.inf], np.nan)
    out.attrs.update(w.attrs)
    return out


def expr_wide_f32(expr: str, instruments: list, start, end, data: BinData, qlib_compat: bool = True) -> pd.DataFrame:
    """What qlib's D.features returns, unstacked: float32, +-inf kept."""
    from qs_idea import parse_expr
    node = parse_expr(expr)
    cal = data.calendar
    si = int(cal.searchsorted(pd.Timestamp(start))) if start is not None else 0
    ei = (int(cal.searchsorted(pd.Timestamp(end), side="right")) - 1) if end is not None else len(cal) - 1
    lb = lookback(node) if qlib_compat else math.inf
    qs = 0 if lb == math.inf else max(0, si - int(lb))
    cols, failed, rows = {}, {}, pd.Index([], dtype="int64")
    for t in instruments:
        def field(f, t=t):
            s = data.field(t, f)
            return s.loc[qs:ei]
        try:
            res = evaluate(node, field)
        except ValueError as e:  # e.g. a field missing for this ticker: qlib crashes the whole query here
            if type(e).__name__ == "IdeaError":
                raise
            failed[t] = f"{type(e).__name__}: {e}"[:200]
            continue
        if not isinstance(res, pd.Series):
            raise _err("表达式算出来是一个常数，没法在股票之间比较")
        try:
            res = res.astype(np.float32)
        except (ValueError, TypeError):
            pass
        res = res.loc[si:ei]
        rows = rows.union(res.index)
        cols[t] = pd.Series(res.to_numpy(), index=cal[res.index]) if len(res) else pd.Series(dtype="float32")
    w = pd.DataFrame(cols).reindex(index=cal[si:ei + 1], columns=list(instruments)).astype("float32")
    w.attrs["failed"] = failed  # tickers left all-NaN because their data could not be evaluated
    # what qlib's D.features + unstack would contain: tickers with data in range, dates covered by any of them
    w.attrs["present"] = [t for t in instruments if t in cols and len(cols[t])]
    w.attrs["rows"] = list(cal[rows])  # plain list: pandas compares attrs when it combines frames
    return w


def fields_wide(data: BinData, names: list, fields: list, start=None, end=None) -> dict:
    """{field: dates x tickers float32}, the same frames as qlib's D.features(names, ["$f", ...], start, end)
    unstacked: each ticker contributes its own data span within [start, end]; dates are the union of those
    spans; tickers with no data in the range are left out."""
    cal = data.calendar
    si = int(cal.searchsorted(pd.Timestamp(start))) if start is not None else 0
    ei = (int(cal.searchsorted(pd.Timestamp(end), side="right")) - 1) if end is not None else len(cal) - 1
    cols = {f: {} for f in fields}
    for t in names:
        ss = {f: data.field(t, f).loc[si:ei] for f in fields}
        idx = pd.Index([], dtype="int64")
        for s in ss.values():
            idx = idx.union(s.index)
        if not len(idx):
            continue
        for f, s in ss.items():
            cols[f][t] = pd.Series(s.reindex(idx).to_numpy(dtype="float32"), index=cal[idx])
    out = {}
    for f in fields:
        df = pd.DataFrame(cols[f])
        df.index.name, df.columns.name = "datetime", "instrument"
        out[f] = df.sort_index().astype("float32")
    return out
