"""Idea test (想法检验): test user-specified factors on the point-in-time universe, development
period only, with an honest verdict.

Pure functions (no Qlib import at module level; tested by test_qs_idea.py):
  * validate_idea      strict input validation (Chinese error messages)
  * tokenize / parse_expr   whitelist tokenizer + recursive-descent parser for Qlib expressions.
                       A user string reaches Qlib's own parser (which ends in Python eval) only after
                       it passed both; nothing here ever evals anything.
  * cs_rank / combine_components   per-day cross-sectional ranks, weighted, re-ranked
  * fwd_returns, daily_rank_ic, nw_tstat, ic_stats, quantile_stats, top_turnover, mean_cs_corr
  * t_threshold, registry_*        multiple-testing control across ideas on one universe
  * evaluate_factor, judge         statistics and verdict for one factor

Data helpers (no qlib: formulas run in qs_expr on the run's data directory): set_provider, expr_wide,
component_frames, factor_scores (signal export).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import re
from pathlib import Path
from statistics import NormalDist

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Limits and names
# ---------------------------------------------------------------------------

MAX_FACTORS = 5
MAX_COMPONENTS = 4
MAX_EXPR_LEN = 300
MAX_PAREN_DEPTH = 12
MAX_WINDOW = 1000
MAX_HORIZONS = 4
HORIZON_RANGE = (1, 120)
DEFAULT_HORIZONS = [5, 20, 60]

FIELDS = {"open", "high", "low", "close", "volume", "vwap", "factor", "mkt"}
# $mkt: market return of the run's own universe, built per run in phase_data (see market_return) and written
# into the run's Qlib provider as an extra field, the same value for every instrument. It lets a formula
# remove market sensitivity, e.g. rolling beta Cov(r,$mkt,252)/Var($mkt,252) or residual volatility.
MARKET_FIELD = "mkt"
MARKET_MIN_NAMES = 20  # fewer eligible names with a return that day -> $mkt is missing (NaN), not a noisy mean
# Qlib operator whitelist -> argument spec. "f" = expression, "n" = non-negative number literal
# (window / shift; a literal so look-ahead such as Ref($close,-5) is impossible), "q" = literal in [0,1],
# "x" = expression or literal.
OPS = {
    **{k: ("f", "n") for k in ("Ref", "Mean", "Std", "Var", "Sum", "Max", "Min", "Med", "Mad", "Skew", "Kurt",
                                "Delta", "Slope", "Rsquare", "Resi", "Rank", "IdxMax", "IdxMin", "EMA", "WMA",
                                "Count")},
    "Corr": ("f", "f", "n"), "Cov": ("f", "f", "n"),
    "Abs": ("f",), "Log": ("f",), "Sign": ("f",), "Not": ("f",),
    "Power": ("x", "x"), "Greater": ("x", "x"), "Less": ("x", "x"),
    **{k: ("x", "x") for k in ("Gt", "Ge", "Lt", "Le", "Eq", "Ne", "And", "Or")},
    "If": ("x", "x", "x"),
    "Quantile": ("f", "n", "q"),
    "Mask": None,  # whitelisted by name, but needs an instrument string (quotes are forbidden): unusable here
}

KNOWN_FACTORS = {  # higher value = what the factor would buy
    "momentum_12_1": "Ref($close,21)/Ref($close,252)-1",
    "reversal_1m": "Ref($close,21)/$close-1",
    "volatility_60d": "Std($close/Ref($close,1)-1,60)",
    "size_dollar_volume": "Log(Mean($close*$volume,60)+1)",
}
KNOWN_FUND = {"value_earnings_yield": "F_EP"}
KNOWN_ZH = {"momentum_12_1": "12-1 动量", "reversal_1m": "1 个月反转", "volatility_60d": "60 日波动率",
            "size_dollar_volume": "规模（成交额）", "value_earnings_yield": "价值（盈利收益率 E/P）"}

def fund_features() -> dict:
    import qs_fundamentals as F  # numpy/pandas only at import time
    return dict(F.FEATURES)


class IdeaError(ValueError):
    """Invalid idea input; the message is Chinese and shown to the user."""


# ---------------------------------------------------------------------------
# Expression whitelist: tokenizer + parser (no eval)
# ---------------------------------------------------------------------------

_TOKEN = re.compile(r"\s+|(?P<feat>\$[A-Za-z_]\w*)|(?P<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?P<ident>[A-Za-z_]\w*)"
                    r"|(?P<op>>=|<=|==|!=|[+\-*/(),<>&|])")
_FORBIDDEN = [("__", "双下划线 __"), ("'", "引号"), ('"', "引号"), ("[", "方括号 []"), ("]", "方括号 []"),
              ("{", "花括号 {}"), ("}", "花括号 {}"), (";", "分号 ;"), (":", "冒号 :"), ("\\", "反斜杠 \\"),
              ("`", "反引号"), ("#", "#"), ("@", "@")]


def tokenize(expr: str) -> list:
    """[(kind, text)] with kind in feat/num/ident/op. Raises IdeaError (Chinese) on anything outside the
    whitelist: fields $open $high $low $close $volume $vwap $factor $mkt, numeric literals, + - * / ( ) , < > =
    ! & | and spaces, and the Qlib operator names in OPS."""
    if not isinstance(expr, str) or not expr.strip():
        raise IdeaError("表达式不能为空")
    if len(expr) > MAX_EXPR_LEN:
        raise IdeaError(f"表达式太长（{len(expr)} 个字符，上限 {MAX_EXPR_LEN}）")
    for bad, zh in _FORBIDDEN:
        if bad in expr:
            raise IdeaError(f"表达式里不能有{zh}")
    out, i = [], 0
    while i < len(expr):
        m = _TOKEN.match(expr, i)
        if not m or m.end() == i:
            ch = expr[i]
            if ch == ".":
                raise IdeaError("表达式里的点号 . 只能出现在数字里（比如 0.5）")
            raise IdeaError(f"表达式里有不允许的字符：{ch!r}")
        i = m.end()
        kind = m.lastgroup
        if kind is None:  # whitespace
            continue
        text = m.group(kind)
        if kind == "feat" and text[1:] not in FIELDS:
            raise IdeaError(f"不认识的数据字段 {text}；只能用 " + " ".join("$" + f for f in sorted(FIELDS)))
        if kind == "ident" and text not in OPS:
            raise IdeaError(f"不认识的名字 {text!r}；只能用这些 Qlib 运算符：" + "、".join(sorted(OPS)))
        if kind == "num" and i < len(expr) and (expr[i].isalpha() or expr[i] in "_$"):
            raise IdeaError(f"数字 {text} 后面紧跟着字母，写法不对")
        out.append((kind, text))
    return out


class _Parser:
    """Python-precedence grammar (Qlib evaluates expressions with Python operators):
         cmp  := bor [ (> < >= <= == !=) bor ]        (no chaining)
         bor  := band ( | band )*
         band := sum ( & sum )*
         sum  := term ( (+|-) term )*
         term := unary ( (*|/) unary )*
         unary:= - unary | + unary | primary
         primary := num | feat | ident ( args ) | ( cmp )
    Nodes: ("num", v) ("feat", f) ("call", op, [args]) ("bin", op, a, b) ("neg", a)."""

    def __init__(self, toks):
        self.t, self.i, self.depth = toks, 0, 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, text=None):
        k, v = self.peek()
        if k is None:
            raise IdeaError("表达式不完整（结尾缺内容或缺右括号）")
        if text is not None and v != text:
            raise IdeaError(f"表达式写法不对：这里应该是 {text!r}，实际是 {v!r}")
        self.i += 1
        return k, v

    def parse(self):
        node = self.cmp()
        if self.i != len(self.t):
            raise IdeaError(f"表达式写法不对：多出了 {self.t[self.i][1]!r}")
        return node

    def cmp(self):
        a = self.bor()
        if self.peek()[1] in (">", "<", ">=", "<=", "==", "!="):
            op = self.take()[1]
            b = self.bor()
            if self.peek()[1] in (">", "<", ">=", "<=", "==", "!="):
                raise IdeaError("不支持连写比较（a > b > c）；请用 And(Gt(a,b), Gt(b,c))")
            return ("bin", op, a, b)
        return a

    def _chain(self, sub, ops):
        a = sub()
        while self.peek()[1] in ops:
            op = self.take()[1]
            a = ("bin", op, a, sub())
        return a

    def bor(self):
        return self._chain(self.band, ("|",))

    def band(self):
        return self._chain(self.sum, ("&",))

    def sum(self):
        return self._chain(self.term, ("+", "-"))

    def term(self):
        return self._chain(self.unary, ("*", "/"))

    def unary(self):
        if self.peek()[1] in ("-", "+"):
            op = self.take()[1]
            a = self.unary()
            if op == "+":
                return a
            return ("num", -a[1]) if a[0] == "num" else ("neg", a)
        return self.primary()

    def primary(self):
        k, v = self.take()
        if k == "num":
            return ("num", float(v))
        if k == "feat":
            return ("feat", v[1:])
        if k == "ident":
            if self.peek()[1] != "(":
                raise IdeaError(f"{v} 是运算符，后面要跟括号，比如 {v}($close, 20)")
            self.take("(")
            args = [] if self.peek()[1] == ")" else self._args()
            self.take(")")
            return ("call", v, args)
        if v == "(":
            self.depth += 1
            if self.depth > MAX_PAREN_DEPTH:
                raise IdeaError(f"括号嵌套太深（上限 {MAX_PAREN_DEPTH} 层）")
            node = self.cmp()
            self.take(")")
            self.depth -= 1
            return node
        raise IdeaError(f"表达式写法不对：不应该出现 {v!r}")

    def _args(self):
        self.depth += 1
        if self.depth > MAX_PAREN_DEPTH:
            raise IdeaError(f"括号嵌套太深（上限 {MAX_PAREN_DEPTH} 层）")
        args = [self.cmp()]
        while self.peek()[1] == ",":
            self.take(",")
            args.append(self.cmp())
        self.depth -= 1
        return args


def _check_node(node):
    """Arity and argument kinds; window/shift arguments must be non-negative literals (no look-ahead)."""
    kind = node[0]
    if kind == "call":
        op, args = node[1], node[2]
        spec = OPS[op]
        if spec is None:
            raise IdeaError(f"{op} 需要写股票代码字符串，想法检验里不支持")
        if len(args) != len(spec):
            raise IdeaError(f"{op} 需要 {len(spec)} 个参数，写了 {len(args)} 个")
        for a, s in zip(args, spec):
            if s in ("n", "q"):
                if a[0] != "num":
                    raise IdeaError(f"{op} 的窗口/位移参数必须直接写数字")
                if s == "n" and not (0 <= a[1] <= MAX_WINDOW):
                    raise IdeaError(f"{op} 的窗口/位移参数要在 0 到 {MAX_WINDOW} 之间（负数会用到未来的数据）")
                if s == "n" and op != "EMA" and a[1] != int(a[1]):
                    raise IdeaError(f"{op} 的窗口参数必须是整数")
                if s == "q" and not (0 <= a[1] <= 1):
                    raise IdeaError(f"{op} 的分位数参数要在 0 到 1 之间")
            else:
                if s == "f" and a[0] == "num":
                    raise IdeaError(f"{op} 的第一个参数应该是数据表达式，不是数字")
                _check_node(a)
    elif kind == "bin":
        _check_node(node[2])
        _check_node(node[3])
    elif kind == "neg":
        _check_node(node[1])


def _has_feature(node, stock_only=False) -> bool:
    """Does the expression read a data field? stock_only: a per-stock field (anything but $mkt)."""
    if node[0] == "feat":
        return not (stock_only and node[1] == MARKET_FIELD)
    if node[0] == "call":
        return any(_has_feature(a, stock_only) for a in node[2])
    if node[0] == "bin":
        return _has_feature(node[2], stock_only) or _has_feature(node[3], stock_only)
    if node[0] == "neg":
        return _has_feature(node[1], stock_only)
    return False


def parse_expr(expr: str):
    """Validate a Qlib expression without evaluating it. Returns the AST; raises IdeaError."""
    node = _Parser(tokenize(expr)).parse()
    _check_node(node)
    if not _has_feature(node):
        raise IdeaError("表达式里至少要用到一个数据字段（比如 $close）")
    if not _has_feature(node, stock_only=True):
        raise IdeaError("只用 $mkt 的公式对每只股票都一样，没法在股票之间比较；要和股票自己的字段（比如 $close）一起用")
    return node


def canonical_expr(expr: str) -> str:
    return re.sub(r"\s+", "", expr)


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")


def resolve_fundamental(name, available=None) -> str:
    """Exact key of qs_fundamentals.FEATURES, matched case-insensitively (no other aliases)."""
    available = available if available is not None else fund_features()
    s = str(name or "").strip()
    if s.upper() in available:
        return s.upper()
    names = "；".join(f"{k}（{v}）" for k, v in available.items())
    raise IdeaError(f"没有叫 {s!r} 的基本面因子。可用的有：{names}")


def validate_idea(obj, available_fund=None) -> dict:
    """Strictly validate idea.json content; returns a normalised spec. Raises IdeaError (Chinese)."""
    available_fund = available_fund if available_fund is not None else fund_features()
    if not isinstance(obj, dict):
        raise IdeaError("idea.json 的内容必须是一个 JSON 对象")
    unknown = set(obj) - {"idea", "horizons", "factors"}
    if unknown:
        raise IdeaError(f"idea.json 里有不认识的字段：{sorted(unknown)}")
    idea = obj.get("idea")
    if not isinstance(idea, str) or not idea.strip():
        raise IdeaError("缺少 idea（一句话描述你的想法）")
    if len(idea) > 500:
        raise IdeaError("idea 描述太长（上限 500 字）")
    hz = obj.get("horizons", DEFAULT_HORIZONS)
    if not isinstance(hz, list) or not hz or len(hz) > MAX_HORIZONS:
        raise IdeaError(f"horizons 必须是 1 到 {MAX_HORIZONS} 个持有天数，比如 [5, 20, 60]")
    for h in hz:
        if isinstance(h, bool) or not isinstance(h, int) or not HORIZON_RANGE[0] <= h <= HORIZON_RANGE[1]:
            raise IdeaError(f"持有天数 {h!r} 不合法：要是 {HORIZON_RANGE[0]} 到 {HORIZON_RANGE[1]} 之间的整数（交易日）")
    hz = sorted(set(hz))
    facs = obj.get("factors")
    if not isinstance(facs, list) or not facs:
        raise IdeaError("factors 至少要有 1 个因子")
    if len(facs) > MAX_FACTORS:
        raise IdeaError(f"一个想法最多检验 {MAX_FACTORS} 个因子（写了 {len(facs)} 个）：因子越多，多重检验的门槛越高")
    out, seen = [], set()
    for i, f in enumerate(facs, 1):
        if not isinstance(f, dict):
            raise IdeaError(f"第 {i} 个因子必须是 JSON 对象")
        bad = set(f) - {"name", "label", "components"}
        if bad:
            raise IdeaError(f"第 {i} 个因子有不认识的字段：{sorted(bad)}")
        name = f.get("name")
        if not isinstance(name, str) or not _NAME.match(name):
            raise IdeaError(f"第 {i} 个因子的 name {name!r} 不合法：用英文字母开头，只含字母、数字、下划线，最长 40 个字符")
        if name.lower() in seen:
            raise IdeaError(f"因子名 {name} 重复了")
        seen.add(name.lower())
        label = f.get("label", name)
        if not isinstance(label, str) or len(label) > 60:
            raise IdeaError(f"因子 {name} 的 label 必须是不超过 60 字的文字")
        comps = f.get("components")
        if not isinstance(comps, list) or not comps:
            raise IdeaError(f"因子 {name} 至少要有 1 个组成部分（components）")
        if len(comps) > MAX_COMPONENTS:
            raise IdeaError(f"因子 {name} 最多 {MAX_COMPONENTS} 个组成部分（写了 {len(comps)} 个）")
        norm = []
        for j, c in enumerate(comps, 1):
            where = f"因子 {name} 的第 {j} 个组成部分"
            if not isinstance(c, dict):
                raise IdeaError(f"{where}必须是 JSON 对象")
            bad = set(c) - {"expr", "fundamental", "weight"}
            if bad:
                raise IdeaError(f"{where}有不认识的字段：{sorted(bad)}")
            if ("expr" in c) == ("fundamental" in c):
                raise IdeaError(f"{where}要么写 expr（价量表达式），要么写 fundamental（基本面因子名），只能二选一")
            w = c.get("weight", 1)
            if isinstance(w, bool) or not isinstance(w, (int, float)) or not math.isfinite(w) or w == 0 or abs(w) > 100:
                raise IdeaError(f"{where}的 weight 必须是非零数字（-100 到 100），负数表示越低越好")
            if "expr" in c:
                try:
                    parse_expr(c["expr"])
                except IdeaError as e:
                    raise IdeaError(f"{where}：{e}") from None
                norm.append({"expr": c["expr"].strip(), "weight": float(w)})
            else:
                try:
                    norm.append({"fundamental": resolve_fundamental(c["fundamental"], available_fund), "weight": float(w)})
                except IdeaError as e:
                    raise IdeaError(f"{where}：{e}") from None
        out.append({"name": name, "label": label.strip() or name, "components": norm, "hash": factor_hash(norm)})
    return {"idea": idea.strip(), "horizons": hz, "factors": out}


def factor_hash(components) -> str:
    """Order-free hash of a factor's definition (weights normalised by their absolute sum)."""
    tot = sum(abs(c["weight"]) for c in components) or 1.0
    parts = sorted(json.dumps({"k": "expr" if "expr" in c else "fund",
                               "v": canonical_expr(c["expr"]) if "expr" in c else c["fundamental"].upper(),
                               "w": round(c["weight"] / tot, 6)}, sort_keys=True) for c in components)
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def idea_hash(spec) -> str:
    return hashlib.sha256(json.dumps({"h": spec["horizons"], "f": [(f["name"], f["hash"]) for f in spec["factors"]]},
                                     sort_keys=True).encode()).hexdigest()[:12]


def uses_fundamentals(spec) -> bool:
    return any("fundamental" in c for f in (spec or {}).get("factors", []) for c in f["components"])


def uses_market(spec) -> bool:
    """True if any expression component reads $mkt (the run then builds the market-return field)."""
    for f in (spec or {}).get("factors", []):
        for c in f["components"]:
            if "expr" in c and any(k == "feat" and t[1:] == MARKET_FIELD for k, t in tokenize(c["expr"])):
                return True
    return False


def market_return(closes: pd.DataFrame, eligible: pd.DataFrame, min_names: int = MARKET_MIN_NAMES) -> pd.Series:
    """Point-in-time equal-weight market return of the universe, one value per day.

    On day t: the names that are index members with a price on t (`eligible`, the same mask the idea test
    scores on) AND have a close on t-1; their simple returns close_t / close_{t-1} - 1, averaged with equal
    weight. Only data from t and t-1 is used, so the series never looks ahead; membership is the
    point-in-time membership of day t. Days with fewer than `min_names` such names are NaN."""
    c = closes.astype("float64")
    r = (c / c.shift(1) - 1.0).replace([np.inf, -np.inf], np.nan)
    m = eligible.reindex(index=c.index, columns=c.columns, fill_value=False).fillna(False).astype(bool)
    r = r.where(m & c.shift(1).notna() & c.notna())
    n = r.notna().sum(axis=1)
    out = r.mean(axis=1, skipna=True).where(n >= min_names)
    out.name = MARKET_FIELD
    return out


# ---------------------------------------------------------------------------
# Cross-sectional scores
# ---------------------------------------------------------------------------

def cs_rank(df: pd.DataFrame) -> pd.DataFrame:
    """Per-date percentile rank among the non-missing names (average ties), in (0, 1]."""
    return df.rank(axis=1, pct=True)


def combine_components(parts, eligible: pd.DataFrame | None = None) -> pd.DataFrame:
    """parts: [(wide raw values, weight)]. Each part is masked to eligible name-days, ranked per date,
    the ranks are summed with the weights (negative weight = lower is better), and the sum is ranked
    again. A name-day needs every component. Higher result = buy."""
    acc, have = None, None
    for raw, w in parts:
        x = raw.replace([np.inf, -np.inf], np.nan)
        if eligible is not None:
            x = x.reindex(index=eligible.index, columns=eligible.columns).where(eligible)
        r = cs_rank(x) * w
        acc = r if acc is None else acc.add(r, fill_value=0.0)
        have = r.notna() if have is None else (have & r.notna())
    return cs_rank(acc.where(have))


def fwd_returns(opens: pd.DataFrame, h: int) -> pd.DataFrame:
    """h-day label of the engine (qs_core.label_expr): open(t+1+h) / open(t+1) - 1."""
    return opens.shift(-(h + 1)) / opens.shift(-1) - 1


def daily_rank_ic(score: pd.DataFrame, ret: pd.DataFrame, min_names: int = 5) -> pd.Series:
    """Spearman correlation per date (same definition as qlib calc_ic's rank IC), vectorised."""
    ret = ret.reindex(index=score.index, columns=score.columns)
    m = score.notna() & ret.notna()
    a = score.where(m).rank(axis=1)
    b = ret.where(m).rank(axis=1)
    a = a.sub(a.mean(axis=1), axis=0)
    b = b.sub(b.mean(axis=1), axis=0)
    den = np.sqrt((a ** 2).sum(axis=1) * (b ** 2).sum(axis=1))
    ic = (a * b).sum(axis=1) / den.replace(0, np.nan)
    return ic[m.sum(axis=1) >= min_names].dropna()


def nw_lags(h: int, n: int) -> int:
    """Newey-West lag for daily IC of h-day overlapping labels: 2h (slow factors stay autocorrelated
    beyond the label overlap), at least 10, at most n/4."""
    return int(max(1, min(max(2 * h, 10), n // 4)))


def nw_tstat(x: pd.Series, lags: int) -> float:
    """t-stat of the mean with Newey-West (Bartlett) HAC standard error."""
    v = np.asarray(pd.Series(x).dropna(), dtype=float)
    n = len(v)
    if n < 10:
        return float("nan")
    e = v - v.mean()
    s = float(np.sum(e * e)) / n
    for l in range(1, min(lags, n - 1) + 1):
        s += 2 * (1 - l / (lags + 1)) * float(np.sum(e[l:] * e[:-l])) / n
    return float(v.mean() / math.sqrt(s / n)) if s > 0 else float("nan")


def ic_stats(ic: pd.Series, h: int) -> dict:
    n = len(ic)
    if n < 10:
        return {"mean": None, "ir": None, "t": None, "t_nonoverlap": None, "pos_share": None, "days": int(n), "nw_lags": None}
    no = ic.iloc[::max(h, 1)]
    t_no = float(no.mean() / (no.std() / math.sqrt(len(no)))) if len(no) > 2 and no.std() > 0 else float("nan")
    L = nw_lags(h, n)
    return {"mean": float(ic.mean()), "ir": float(ic.mean() / ic.std()) if ic.std() > 0 else None,
            "t": nw_tstat(ic, L), "t_nonoverlap": t_no, "pos_share": float((ic > 0).mean()), "days": int(n), "nw_lags": L}


CLIP_MAD = 10.0  # per-day robust clip of forward returns for the quintile means: median +- 10 x scaled MAD


def winsorize_rows(df: pd.DataFrame, k: float = CLIP_MAD) -> pd.DataFrame:
    """Clip each row to median +- k x 1.4826 x MAD of that day, so one corrupt price (e.g. a 1000x jump
    in an old series) cannot dominate a cross-sectional mean. Rank statistics are unaffected."""
    med = df.median(axis=1)
    mad = df.sub(med, axis=0).abs().median(axis=1) * 1.4826
    return df.clip(lower=med - k * mad, upper=med + k * mad, axis=0)


def quantile_stats(score: pd.DataFrame, ret: pd.DataFrame, h: int, n_q: int = 5, cost_bps: float = 10.0,
                   min_names: int = 10) -> dict:
    """Mean h-day forward return per score quintile (Q1 lowest .. Q5 highest), on every day, annualised
    arithmetically (x 252/h, as Qlib's signal analysis does). Long-short = Q5 - Q1; net of the cost of
    replacing names in both legs when rebalancing every h days. Returns are clipped per day at
    median +- 10 MAD first (robust to corrupt price points)."""
    ret = ret.reindex(index=score.index, columns=score.columns)
    m = score.notna() & ret.notna()
    ret = winsorize_rows(ret.where(m))
    ok = m.sum(axis=1) >= min_names
    s, r = score.where(m)[ok], ret.where(m)[ok]
    if not len(s):
        return {"horizon": h, "annual_returns": [None] * n_q, "long_short_annual": None, "long_short_net_annual": None,
                "monotonic": False, "days": 0}
    pct = s.rank(axis=1, pct=True)
    q = np.ceil(pct * n_q).clip(1, n_q)
    means = []
    for k in range(1, n_q + 1):
        means.append(r.where(q == k).mean(axis=1))
    qm = pd.concat(means, axis=1)
    ann = (qm.mean() * 252 / h).tolist()
    ls = (qm.iloc[:, -1] - qm.iloc[:, 0])
    ls_ann = float(ls.mean() * 252 / h)
    to_top, to_bot = top_turnover(score, h, n_q, top=True), top_turnover(score, h, n_q, top=False)
    cost = cost_bps / 1e4 * 2 * ((to_top or 0) + (to_bot or 0)) * 252 / h
    return {"horizon": h, "annual_returns": [float(a) for a in ann], "long_short_annual": ls_ann,
            "long_short_net_annual": ls_ann - cost, "annual_cost": cost,
            "monotonic": bool(all(b > a for a, b in zip(ann, ann[1:]))), "days": int(len(qm)),
            "turnover_top": to_top, "turnover_bottom": to_bot}


def top_turnover(score: pd.DataFrame, h: int, n_q: int = 5, top: bool = True, min_names: int = 10):
    """Average share of the top (or bottom) quintile replaced at each rebalance, every h days."""
    s = score[score.notna().sum(axis=1) >= min_names]
    prev, vals = None, []
    for d in s.index[::max(h, 1)]:
        row = s.loc[d].dropna()
        k = max(1, int(round(len(row) / n_q)))
        cur = set((row.nlargest(k) if top else row.nsmallest(k)).index)
        if prev is not None and cur:
            vals.append(1 - len(cur & prev) / len(cur))
        prev = cur
    return float(np.mean(vals)) if vals else None


def extreme_moves(opens: pd.DataFrame, eligible: pd.DataFrame, up: float = 1.0, down: float = -0.8) -> dict:
    """Data-quality probe: eligible name-days whose open-to-open return is above +100% or below -80%
    in ONE day (almost always a corrupt or mis-mapped price series for index members)."""
    r = opens.pct_change(fill_method=None).where(eligible.reindex(index=opens.index, columns=opens.columns).fillna(False).astype(bool))
    bad = (r > up) | (r < down)
    n = int(bad.values.sum())
    by = bad.sum().sort_values(ascending=False)
    return {"count": n, "tickers": [str(t) for t in by[by > 0].index[:10]],
            "rule": f"one-day open-to-open return > {up:+.0%} or < {down:+.0%} while an eligible member"}


def mean_cs_corr(a: pd.DataFrame, b: pd.DataFrame, step: int = 5, min_names: int = 10):
    """Average per-date Spearman correlation of two scores (every `step`-th date)."""
    idx = a.index[::step]
    c = daily_rank_ic(a.loc[idx], b.reindex(index=idx), min_names)
    return float(c.mean()) if len(c) else None


# ---------------------------------------------------------------------------
# Multiple testing
# ---------------------------------------------------------------------------

ALPHA = 0.05
T_FLOOR = 2.0


def t_threshold(m: int, alpha: float = ALPHA) -> float:
    """Bonferroni-adjusted two-sided critical t for m tests (normal approximation), never below 2.0."""
    m = max(int(m), 1)
    return float(max(T_FLOOR, NormalDist().inv_cdf(1 - alpha / (2 * m))))


def registry_path() -> Path:
    return Path(os.environ.get("QS_IDEA_REGISTRY") or os.path.expanduser("~/.qlib/qs_cache/idea_registry.jsonl"))


def registry_read(path) -> list:
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def registry_add(path, universe: str, dev_window, factors, horizons, extra=None) -> int:
    """Append-only: one line per factor not yet registered on this universe with these horizons.
    Returns the number of lines appended."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    have = {}
    for r in registry_read(p):
        if r.get("universe") == universe:
            have.setdefault(r["factor_hash"], set()).update(r.get("horizons") or [])
    n = 0
    with open(p, "a") as fh:
        for f in factors:
            if f["hash"] in have and set(horizons) <= have[f["hash"]]:
                continue
            fh.write(json.dumps({"universe": universe, "dev_window": list(dev_window), "factor_hash": f["hash"],
                                 "name": f["name"], "horizons": list(horizons),
                                 "components": f["components"],
                                 "at": dt.datetime.now().isoformat(timespec="seconds"), **(extra or {})},
                                ensure_ascii=False) + "\n")
            have.setdefault(f["hash"], set()).update(horizons)
            n += 1
    return n


def registry_trials(path, universe: str) -> dict:
    """Distinct factors ever tested on the universe, and total tests (sum over factors of the distinct
    horizons each was tested at)."""
    have = {}
    for r in registry_read(path):
        if r.get("universe") == universe:
            have.setdefault(r["factor_hash"], set()).update(r.get("horizons") or [])
    return {"factors": len(have), "tests": int(sum(len(v) for v in have.values()))}


# ---------------------------------------------------------------------------
# Evaluation and verdict
# ---------------------------------------------------------------------------

YEAR_MIN_DAYS = 60
MIN_DAYS = 750          # ~3 years of daily IC observations at the chosen horizon
MIN_COVERAGE = 0.5      # share of eligible member-days with a score
SIGN_SHARE = 2 / 3      # share of calendar years with mean IC > 0
DUP_CORR = 0.8          # |corr| with a known factor above this = that factor in disguise


def evaluate_factor(score: pd.DataFrame, rets: dict, known: dict, cost_bps: float, eligible: pd.DataFrame | None = None) -> dict:
    """Statistics of one factor. score: dates x tickers (higher = buy, NaN = no score); rets: {h: forward
    returns}; known: {name: wide known-factor values}. Everything passed in must already be restricted
    to the development period."""
    ics, stats = {}, {}
    for h, r in sorted(rets.items()):
        ics[h] = daily_rank_ic(score, r)
        stats[str(h)] = ic_stats(ics[h], h)
    cand = [h for h in ics if stats[str(h)]["t"] is not None and np.isfinite(stats[str(h)]["t"])]
    best = max(cand, key=lambda h: stats[str(h)]["t"]) if cand else sorted(rets)[0]
    ic = ics[best]
    by_year = ic.groupby(ic.index.year)
    yr = {str(y): round(float(g.mean()), 4) for y, g in by_year if len(g) >= YEAR_MIN_DAYS}
    share = float(np.mean([v > 0 for v in yr.values()])) if yr else None
    q = quantile_stats(score, rets[best], best, cost_bps=cost_bps)
    corr = {}
    for n, k in known.items():
        v = mean_cs_corr(score, k) if k is not None else None
        corr[n] = None if v is None or not np.isfinite(v) else round(v, 3)
    cov = None
    if eligible is not None:
        el = eligible.reindex(index=score.index, columns=score.columns).fillna(False).astype(bool)
        cov = float((score.notna() & el).values.sum() / max(el.values.sum(), 1))
    return {"coverage": cov, "days": int(len(ic)), "ic": stats, "best_horizon": int(best),
            "quantiles": {k: v for k, v in q.items() if k not in ("turnover_top", "turnover_bottom")},
            "turnover_top_quintile": q.get("turnover_top"), "by_year_ic": yr, "share_years_positive": share,
            "corr_known": corr, "_ic_series": ic}


def judge(res: dict, t_crit: float) -> dict:
    """Verdict signal / weak / none with Chinese reasons (rules documented in idea_report.md)."""
    h = res["best_horizon"]
    s = res["ic"][str(h)]
    t, mean = s.get("t"), s.get("mean")
    reasons, fails = [], []
    if t is None or mean is None or not np.isfinite(t):
        return {"verdict": "none", "verdict_zh": "没有信号", "reasons_zh": ["有效数据太少，算不出可靠的统计量"]}
    reasons.append(f"最好的持有天数是 {h} 天：平均 IC {mean:+.4f}，t = {t:.2f}（Newey-West，{s['nw_lags']} 阶），"
                   f"多重检验门槛 t ≥ {t_crit:.2f}")
    if t < t_crit:
        fails.append("t")
        if t <= -t_crit:
            reasons.append("方向反了而且很显著：分数越高的股票后来反而越差。方向是事先定的，反过来用要当作一个新想法重新检验")
        else:
            reasons.append(f"t 值没有过门槛（{t:.2f} < {t_crit:.2f}），和运气区分不开")
    sh = res.get("share_years_positive")
    if sh is None or sh < SIGN_SHARE:
        fails.append("years")
        reasons.append(f"只有 {0 if sh is None else sh:.0%} 的年份 IC 为正（要求至少 {SIGN_SHARE:.0%}），不稳定")
    else:
        reasons.append(f"{sh:.0%} 的年份 IC 为正")
    q = res["quantiles"]
    net = q.get("long_short_net_annual")
    if net is None or not net > 0:
        fails.append("net")
        reasons.append("扣掉交易成本后多空收益不为正" if net is not None else "分组收益算不出来")
    else:
        reasons.append(f"最高组减最低组每年 {q['long_short_annual']:+.1%}，扣成本后 {net:+.1%}"
                       + ("，五组收益单调递增" if q.get("monotonic") else "，但五组收益不是单调的"))
    if res["days"] < MIN_DAYS:
        fails.append("days")
        reasons.append(f"有效交易日只有 {res['days']} 天（要求至少 {MIN_DAYS} 天）")
    if res.get("coverage") is not None and res["coverage"] < MIN_COVERAGE:
        fails.append("coverage")
        reasons.append(f"只有 {res['coverage']:.0%} 的成分股-交易日有分数（要求至少 {MIN_COVERAGE:.0%}）")
    dup = [(n, c) for n, c in (res.get("corr_known") or {}).items() if c is not None and abs(c) > DUP_CORR]
    for n, c in dup:
        reasons.append(f"和已知因子「{KNOWN_ZH.get(n, n)}」的相关系数是 {c:+.2f}（超过 {DUP_CORR}），基本就是这个已知因子换了个说法，"
                       "所以结论最多是“信号弱”")
    if not fails:
        v = "weak" if dup else "signal"
    elif mean > 0 and t >= T_FLOOR:
        v = "weak"
    else:
        v = "none"
    return {"verdict": v, "verdict_zh": {"signal": "有信号", "weak": "信号弱", "none": "没有信号"}[v], "reasons_zh": reasons}


def summary_zh(factors: list) -> str:
    sig = [f["label"] for f in factors if f["verdict"] == "signal"]
    weak = [f["label"] for f in factors if f["verdict"] == "weak"]
    if sig:
        return f"开发期数据里，「{'」「'.join(sig)}」有经得起多重检验的信号" + (f"；「{'」「'.join(weak)}」信号弱" if weak else "") + \
               "。这还不是样本外结论：验证期没有动过，下一步可以导出信号写成 LEAN 策略回测。"
    if weak:
        return f"开发期数据里，「{'」「'.join(weak)}」有一点迹象但不够硬（没过多重检验门槛、不稳定，或者只是已知因子换了说法），其余没有信号。不建议直接当策略用。"
    return "开发期数据里，这个想法的因子都没有可靠的信号：和随机挑股票区分不开。"


# ---------------------------------------------------------------------------
# Formula evaluation on the run's data directory (qs_expr; no qlib)
# ---------------------------------------------------------------------------

_PROVIDER: dict = {"uri": None, "data": None}


def set_provider(uri) -> None:
    """The run's data directory (Qlib binary layout) that formulas are evaluated on."""
    if uri and _PROVIDER["uri"] != str(uri):
        import qs_expr
        _PROVIDER.update(uri=str(uri), data=qs_expr.BinData(uri))


def expr_wide(expr: str, instruments: list, start, end) -> pd.DataFrame:
    """Evaluate a validated expression on the current provider -> dates x tickers (float64, inf -> NaN).
    qs_expr reproduces qlib 0.9.7's results (fixtures/ and test_qs_expr.py) without importing qlib; formulas
    can only look back (literal, non-negative windows are enforced by parse_expr)."""
    import qs_expr
    if _PROVIDER["data"] is None:
        raise RuntimeError("expr_wide: no data directory set (set_provider)")
    w = qs_expr.expr_wide(expr, instruments, start, end, _PROVIDER["data"])
    out = w.loc[w.attrs["rows"], sorted(w.attrs["present"])]  # the frame shape qlib's D.features + unstack gave
    out.index.name, out.columns.name = "datetime", "instrument"
    out.attrs = {}  # do not carry qs_expr's bookkeeping into later frames
    return out


qlib_expr_wide = expr_wide  # old name, kept for callers


def component_frames(factor: dict, instruments: list, start, end, fund_panel: dict | None, index: pd.DatetimeIndex):
    """[(wide raw values, weight)] for one factor (index = the run's calendar slice)."""
    parts = []
    for c in factor["components"]:
        if "expr" in c:
            w = expr_wide(c["expr"], instruments, start, end)
        else:
            if fund_panel is None or c["fundamental"] not in fund_panel:
                raise IdeaError(f"这次运行没有基本面数据 {c['fundamental']}")
            w = fund_panel[c["fundamental"]].astype("float64")
        parts.append((w.reindex(index=index), c["weight"]))
    return parts


def factor_scores(run_dir, factor_name: str):
    """Daily scores of one idea factor on every date the run's data covers (dev and holdout: a fixed
    formula has nothing fitted), restricted to eligible name-days. Returns (Series (datetime, instrument)
    -> score in (0,1], factor spec, cfg)."""
    rd = Path(run_dir)
    cfg = json.loads((rd / "config.json").read_text())
    spec = cfg.get("idea")
    if not spec:
        raise IdeaError("这次运行不是想法检验（config.json 里没有 idea）")
    fac = next((f for f in spec["factors"] if f["name"].lower() == str(factor_name).lower()), None)
    if fac is None:
        raise IdeaError(f"这次想法检验里没有因子 {factor_name}；有：{', '.join(f['name'] for f in spec['factors'])}")
    da = json.loads((rd / "data_audit.json").read_text())
    set_provider(da["provider_uri"])
    el = pd.read_pickle(rd / "data" / "eligible.pkl")
    cols = [t for t in da["tickers_with_data"] if t in el.columns]
    el = el[cols]
    fp = rd / "data" / "fundamentals.pkl"
    fund = pd.read_pickle(fp) if fp.exists() else None
    parts = component_frames(fac, cols, cfg["start"], None, fund, el.index)
    sc = combine_components(parts, el)
    s = sc.stack()
    s.index.names = ["datetime", "instrument"]
    return s.dropna(), fac, cfg
