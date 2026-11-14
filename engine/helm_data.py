"""Helm 数据助手：在 LEAN 策略里读取 qlib 导出的历史成分股和模型信号。

    from helm_data import HelmUniverse, HelmSignals

    uni = HelmUniverse("sp500")          # 先在 Helm 里准备好这个股票池（prepare_universe）
    for t in uni.tickers():              # 历史上所有成员（含已退市），全部订阅
        self.add_equity(t, Resolution.DAILY)
    members = uni.members(self.time)     # 当天真实的成分股（去除幸存者偏差）

    sig = HelmSignals("p1001_r20261108")     # 研究导出的模型打分（export_signals）
    scores = sig.latest(self.time)       # {ticker: score}，只用严格早于今天的打分，没有前视

    ds = HelmDataset("sp500_adds")       # agent 从网上整理的自建数据集（save_dataset）；只给「严格早于今天」公开的行
    ds.events_until(self.time, "AAPL")   # 当时已公开的事件；ds.value("AAPL", "sector", self.time) 当时已知的最新属性值

    y2 = HelmMacro("DGS2")               # FRED 宏观序列（fetch_macro 下载；回测前会自动下载代码里用到的）
    y2.value(self.time)                  # 当时已经公布的最新值
    y2.change(self.time, 63)             # 和约 63 个日历日前相比的变化

文件放在 LEAN 数据目录下的 helm/ 里，由 Helm 写入。这个模块只在本地 LEAN 可用，搬到 QC 云端时要换成 QC 自己的数据。
"""
import bisect
import csv
import math
import os
from datetime import datetime, timedelta

# `from helm_data import *` 只给这几个名字（不把 os / csv 带进策略）
# 数据都存在下划线开头的属性里（_spells、_by、_dates、_values、_avail、_rows）：整份文件包括“未来”的行都在里面，
# 策略只能通过方法读（方法只给当时已经知道的数据）。lint_strategy.py 拒绝在 self 以外的对象上读下划线属性。
__all__ = ["HelmUniverse", "HelmSignals", "HelmMacro", "HelmDataset"]

_DATA = os.environ.get("HELM_LEAN_DATA") or os.path.join(os.path.dirname(os.path.realpath(__file__)), "Lean", "Data")


def helm_path(*parts):
    return os.path.join(_DATA, "helm", *parts)


# 数据过期保护：信号/股票池只到导出那天。回测跑过这个日期（再加一点容差）后，旧分数不能当新分数用。
STALE_TOLERANCE_TRADING_DAYS = 5
_warned = set()
WARNINGS = []  # 本进程里发出过的全部警告，方便检查


def _warn_once(key, msg):
    """同一条警告只发一次，走 print（LEAN 会把它写进回测日志）。"""
    if key in _warned:
        return
    _warned.add(key)
    WARNINGS.append(msg)
    print(f"[HELM 警告] {msg}", flush=True)


def _trading_days_between(a, b):
    """a 之后到 b（含 b）之间的工作日数（不考虑节假日，只作容差用）。b <= a 返回 0。"""
    d1, d2 = datetime.strptime(a, "%Y-%m-%d").date(), datetime.strptime(b, "%Y-%m-%d").date()
    n, d = 0, d1
    while d < d2:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def _is_stale(last, s):
    return bool(last) and _trading_days_between(last, s) > STALE_TOLERANCE_TRADING_DAYS


def _day(d):
    if isinstance(d, str):
        return d[:10]
    try:
        return d.strftime("%Y-%m-%d")
    except AttributeError:  # .NET DateTime
        return f"{d.Year:04d}-{d.Month:02d}-{d.Day:02d}"


class HelmUniverse:
    """历史成分股。某天只有当时在指数里、而且有价格的股票才算成员。"""

    def __init__(self, key):
        path = helm_path("universes", f"{key}.csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"股票池 {key} 还没准备好：先在 Helm 里运行 prepare_universe('{key}')")
        self.key = key
        self._spells = {}
        with open(path) as f:
            for r in csv.DictReader(f):
                self._spells.setdefault(r["ticker"], []).append((r["start"], r["end"]))
        self.last_date = max((b for sp in self._spells.values() for _, b in sp), default=None)

    def _stale(self, s):
        if _is_stale(self.last_date, s):
            _warn_once(("uni", self.key), f"股票池 {self.key} 的数据只到 {self.last_date}，回测已经跑到 {s}：之后的成分股是空的。请在 Helm 里重新 prepare_universe 更新，或把回测结束日期提前。")
            return True
        return False

    def tickers(self):
        """历史上出现过的全部代码（含已退市）。在 initialize 里全部 add_equity。"""
        return sorted(self._spells)

    def members(self, when):
        """当天的成分股列表。同一天多次调用（选股、调仓、平掉不在指数里的持仓）只算一次；返回副本，改了不影响下次。"""
        s = _day(when)
        if self._stale(s):
            return []
        if getattr(self, "_memo_day", None) != s:
            self._memo = sorted(t for t, sp in self._spells.items() if any(a <= s <= b for a, b in sp))
            self._memo_day = s
        return list(self._memo)

    def is_member(self, ticker, when):
        s = _day(when)
        if self._stale(s):
            return False
        return any(a <= s <= b for a, b in self._spells.get(str(ticker).upper(), ()))


class HelmSignals:
    """qlib 研究导出的每日打分。分数越高越看好。"""

    def __init__(self, name):
        path = helm_path("signals", f"{name}.csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"信号 {name} 不存在：先在 Helm 里运行 export_signals")
        self.name = name
        by = {}
        with open(path) as f:
            for r in csv.DictReader(f):
                by.setdefault(r["date"], {})[r["ticker"]] = float(r["score"])
        self._dates = sorted(by)
        self._by = by
        self.last_date = self._dates[-1] if self._dates else None  # 信号导出到哪一天

    def tickers(self):
        out = set()
        for d in self._by.values():
            out.update(d)
        return sorted(out)

    def latest_date(self, when):
        """严格早于 when 那天的最近一个打分日期（打分用的是那天收盘前的数据，所以今天才能用）。"""
        s = _day(when)
        if _is_stale(self.last_date, s):
            _warn_once(("sig", self.name), f"信号 {self.name} 只到 {self.last_date}，回测已经跑到 {s}：之后拿不到打分（返回空）。请在 Helm 里用新数据重新做研究并导出信号，或把回测结束日期提前。")
            return None
        i = bisect.bisect_left(self._dates, s)
        return self._dates[i - 1] if i > 0 else None

    def latest(self, when):
        d = self.latest_date(when)
        return dict(self._by[d]) if d else {}

    def top(self, when, k, allowed=None):
        """打分最高的 k 只（可以用 allowed 限定在当天的成分股里）。"""
        s = self.latest(when)
        if allowed is not None:
            allowed = set(allowed)
            s = {t: v for t, v in s.items() if t in allowed}
        return [t for t, _ in sorted(s.items(), key=lambda kv: -kv[1])[:k]]


def _parse_day(s):
    return datetime.strptime(s, "%Y-%m-%d")


class HelmMacro:
    """FRED 宏观序列（利率、信用利差、收益率曲线等）。只给「当时已经公布」的值，没有前视。

    FRED 的日期是数据所属的日期，不是公布日期。一个观测从「日期 + 公布滞后」那天之后才能用：
      日度（市场数据，如 DGS2、BAMLH0A0HYM2、T10Y2Y）：滞后 1 天，即只用严格早于今天的值；
      周度：滞后 7 天；
      月度（日期是当月 1 号）：默认滞后 75 天——PCE、个人收入、M2 在次月底才公布（约第 60 天），JOLTS、贸易差额
        要到再下一个月初（约第 70 天），原来统一的 45 天会提前看到它们。公布早的几个按下面 KNOWN_LAG 单独给：
        就业报告（UNRATE、PAYEMS 等）45 天，CPI 50 天；Case-Shiller 房价要 95 天；
      季度（日期是季度第 1 天，如 GDP、GDPC1）：滞后 125 天（初值在季度结束后约 30 天公布，原来的 100 天早了三周）；
      半年度、年度：一个周期 + 270 天。
    滞后按数据间隔自动判断，也可以用 release_lag_days 指定（宁可保守）。
    注意：FRED 给的是修订后的最新值，不是当时公布的初值；GDP、非农这类会修订的序列仍有“修订前视”，结论里要说明。
    """

    KNOWN_LAG = {"UNRATE": 45, "PAYEMS": 45, "CIVPART": 45, "U6RATE": 45, "AHETPI": 45,
                 "CPIAUCSL": 50, "CPILFESL": 50, "CPIAUCNS": 50,
                 "CSUSHPINSA": 95, "CSUSHPISA": 95, "SPCS20RSA": 95, "SPCS20RNSA": 95}

    def __init__(self, series_id, release_lag_days=None):
        sid = str(series_id).upper()
        path = helm_path("macro", f"{sid}.csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"宏观序列 {sid} 还没下载：先在 Helm 里运行 fetch_macro(['{sid}'])（回测前也会自动下载代码里用到的序列）")
        self.id = sid
        rows = []
        with open(path) as f:
            for r in csv.DictReader(f):
                try:
                    v = float(r["value"])
                except (TypeError, ValueError):  # FRED 的缺失值「.」
                    continue
                if math.isfinite(v):
                    rows.append((r["date"], v))
        rows.sort()
        self._dates = [d for d, _ in rows]
        self._values = [v for _, v in rows]
        if release_lag_days is None:
            gaps = sorted((_parse_day(b) - _parse_day(a)).days for a, b in zip(self._dates, self._dates[1:]))
            g = gaps[len(gaps) // 2] if gaps else 1
            release_lag_days = (1 if g <= 3 else 7 if g <= 10 else self.KNOWN_LAG.get(sid, 75) if g <= 40
                                else 125 if g <= 100 else int(g) + 270)
        self.lag = int(release_lag_days)
        # 每个观测最早可用的日期
        self._avail = [(_parse_day(d) + timedelta(days=self.lag)).strftime("%Y-%m-%d") for d in self._dates]

    def _idx(self, when):
        """when 当天能用的最后一个观测的下标（可用日期 <= 今天），没有就返回 -1。"""
        return bisect.bisect_right(self._avail, _day(when)) - 1

    def value(self, when):
        i = self._idx(when)
        return self._values[i] if i >= 0 else None

    def as_of(self, when):
        """(数据日期, 值)：方便在日志里核对用的是哪一天的数据。"""
        i = self._idx(when)
        return (self._dates[i], self._values[i]) if i >= 0 else (None, None)

    def change(self, when, lookback_days):
        """现在能用的值减去 lookback_days 个日历日之前能用的值。"""
        now = self.value(when)
        then = self.value((_parse_day(_day(when)) - timedelta(days=int(lookback_days))).strftime("%Y-%m-%d"))
        return None if now is None or then is None else now - then

    def history(self, when, n):
        """当时能用的最近 n 个观测 [(日期, 值)]。"""
        i = self._idx(when)
        return list(zip(self._dates[max(0, i - n + 1): i + 1], self._values[max(0, i - n + 1): i + 1])) if i >= 0 else []


class HelmDataset:
    """自建数据集（agent 用 save_dataset 从网上整理，存在 helm/custom/<name>.csv）。没有前视：每一行都有 available_date
    （信息第一次公开的日期），查询某一天时只给 available_date 严格早于那一天的行（和 HelmMacro 日度序列同一个约定：
    今天公开的消息，明天才能用）。数据是网上整理的，可能不全或有错，结论依赖这份数据的质量。

    events_until(when, symbol=None)        当时已公开的事件行（字典列表，按公开日期排序）
    value(symbol, field, when)             当时已知的最新值：attributes 按 field，events 按事件名，timeseries 传 field=None
    symbols_with(field, expected, when)    当时 field 的最新值等于 expected（也可以是判断函数）的代码
    last_available_date                    数据里最晚的公开日期
    tickers()                              数据里出现过的全部代码（只用来在 initialize 里 add_equity，不含任何日期信息）
    """

    def __init__(self, name):
        path = helm_path("custom", f"{name}.csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"自建数据集 {name} 不存在：先让 agent 用 save_dataset 创建，或在「股票池与数据」页确认名字")
        self.name = name
        rows = []
        with open(path, newline="") as f:
            for i, r in enumerate(csv.DictReader(f)):
                r["value"] = _dataset_value(r.get("value"))
                r["source"] = int(r["source"]) if (r.get("source") or "").isdigit() else r.get("source")
                rows.append((r["available_date"], r.get("date") or "", i, r))
        rows.sort(key=lambda x: x[:3])
        self._rows = [x[3] for x in rows]
        self._avail = [x[0] for x in rows]
        self._latest = {}
        for r in self._rows:  # 同一代码、同一字段按公开日期（再按所属日期）从早到晚排，最后一个就是最新
            d, v = self._latest.setdefault((r.get("symbol") or "", r.get("field") or r.get("event") or ""), ([], []))
            d.append(r["available_date"])
            v.append(r["value"])
        self.last_available_date = self._avail[-1] if self._avail else None

    def _n(self, when):
        """available_date 严格早于 when 那天的行数（行已按公开日期排序，所以前 n 行就是当时已公开的）。"""
        return bisect.bisect_left(self._avail, _day(when))

    def tickers(self):
        return sorted({r["symbol"] for r in self._rows if r.get("symbol")})

    def events_until(self, when, symbol=None):
        sym = str(symbol).upper() if symbol else None
        return [dict(r) for r in self._rows[: self._n(when)] if sym is None or r.get("symbol") == sym]

    def value(self, symbol, field, when):
        dates, vals = self._latest.get((str(symbol).upper() if symbol else "", field or ""), ((), ()))
        i = bisect.bisect_left(dates, _day(when))
        return vals[i - 1] if i > 0 else None

    def symbols_with(self, field, predicate_value, when):
        ok = predicate_value if callable(predicate_value) else (lambda v: v == predicate_value)
        out = []
        for (sym, key) in self._latest:
            if sym and key == (field or ""):
                v = self.value(sym, field, when)
                if v is not None and ok(v):
                    out.append(sym)
        return sorted(out)


def _dataset_value(v):
    if v is None or v == "":
        return None
    try:
        x = float(v)
        return x if math.isfinite(x) else v
    except ValueError:
        return v
