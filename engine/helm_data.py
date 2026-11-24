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

    br = HelmBreadth("sp500")            # 市场宽度（build_breadth；股票池导出时也会自动算）：只给严格早于今天的值
    br.value(self.time, "pct_above_200") # 站上 200 日均线的成分股比例；还有 "net_highs"、"dispersion"

    vol = HelmVol(target=0.10, max_leverage=1.0)   # 波动率目标：按预测波动率调仓位（不需要任何外部数据）
    vol.update(self.time, daily_return)  # 每个交易日收盘后喂一次策略（或资产）的日收益
    w = vol.scale()                      # 仓位系数 = min(上限, 目标波动率 / 预测波动率)，再乘到原来的目标权重上

    borrow = HelmShortCost(rate=0.005)   # 融券成本：LEAN 回测默认不收，做空的策略必须用它
    borrow.charge(self)                  # 每个交易日调用一次（on_data 开头或收盘后）：按空头市值 × 年化费率 × 天数/360 从现金里扣
    borrow.total                         # 累计扣了多少钱；on_end_of_algorithm 里 self.log(borrow.summary())

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
__all__ = ["HelmUniverse", "HelmSignals", "HelmMacro", "HelmDataset", "HelmVol", "HelmBreadth", "HelmShortCost"]

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


class HelmBreadth:
    """市场宽度：用历史成分股算的每日指标（helm/breadth/<key>.csv，build_breadth 或股票池导出时生成）。

    某一行的日期 d 用的是 d 当天的收盘价，所以策略在 d 当天看不到它，最早 d 的下一个交易日才能用：
    value(when, field) 只给日期严格早于 when 的最新一行。字段：
      pct_above_200  站上自己 200 日均线的成分股比例（0–1，越高越健康）
      net_highs      创 52 周新高的比例减创新低的比例（-1–1）
      dispersion     成分股 21 日收益的横截面标准差（越高市场越分化）
    """

    FIELDS = ("pct_above_200", "net_highs", "dispersion", "members")

    def __init__(self, key="sp500"):
        path = helm_path("breadth", f"{key}.csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"还没有 {key} 的市场宽度：先在 Helm 里运行 build_breadth('{key}')（要先 prepare_universe('{key}')）")
        self.key = key
        self._dates, self._rows = [], []
        with open(path) as f:
            for r in csv.DictReader(f):
                row = {}
                for k in self.FIELDS:
                    try:
                        v = float(r.get(k, ""))
                        row[k] = v if math.isfinite(v) else None
                    except (TypeError, ValueError):
                        row[k] = None
                self._dates.append(r["date"][:10])
                self._rows.append(row)
        self.last_date = self._dates[-1] if self._dates else None

    def _idx(self, when):
        s = _day(when)
        if _is_stale(self.last_date, s):
            _warn_once(("breadth", self.key), f"市场宽度 {self.key} 只到 {self.last_date}，回测已经跑到 {s}：之后没有新值。请重新 prepare_universe 或 build_breadth 更新。")
            return -1
        return bisect.bisect_left(self._dates, s) - 1  # 严格早于今天

    def value(self, when, field="pct_above_200"):
        if field not in self.FIELDS:
            raise ValueError(f"HelmBreadth 没有字段 {field}（可选：{', '.join(self.FIELDS)}）")
        i = self._idx(when)
        return self._rows[i][field] if i >= 0 else None

    def as_of(self, when):
        """(数据日期, 那一行的全部字段)：方便在日志里核对用的是哪一天。"""
        i = self._idx(when)
        return (self._dates[i], dict(self._rows[i])) if i >= 0 else (None, None)

    def history(self, when, field="pct_above_200", n=20):
        i = self._idx(when)
        if i < 0:
            return []
        lo = max(0, i - int(n) + 1)
        return [(self._dates[k], self._rows[k][field]) for k in range(lo, i + 1)]


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



# ---------------------------------------------------------------------------
# HelmVol：波动率预测 + 仓位系数（波动率目标）
# ---------------------------------------------------------------------------
# 收益难预测，波动率好预测：今天波动大，接下来几周大概率也大。按预测波动率缩放仓位，
# 不改变策略选什么、何时买卖，只改「买多少」，目标是把回撤和波动压下来。
#
# 方法（事先定好，不在回测里挑）：
#   - HAR（Corsi 2009, "A Simple Approximate Long-Memory Model of Realized Volatility"）：
#     未来 h 天的平均日方差 ≈ b0 + b1·昨天的平方收益 + b2·过去 5 天平均 + b3·过去 22 天平均。
#     用到「现在」为止、目标窗口已经完整发生的样本做最小二乘（扩张窗口），每 refit_every 天重估一次。
#   - EWMA（RiskMetrics, λ = 0.94）：历史不够 min_history 天、或 HAR 给出非正 / 离谱的预测时的后备。
#   - 历史连 EWMA 都不够（< 22 天）时 forecast() 返回 None，scale() 返回 1（不调仓位）。
# 只能逐日 update，不能回头改历史；所有估计只用已经 update 过的数据，不可能看到未来。

class HelmVol:
    TRADING_DAYS = 252

    def __init__(self, target=0.10, max_leverage=1.0, horizon=21, min_history=504, refit_every=21,
                 method="har", ewma_lambda=0.94, min_scale=0.0):
        if not (0 < target < 2):
            raise ValueError("target 是年化波动率目标，比如 0.10 = 10%")
        if not (0 < max_leverage <= 3):
            raise ValueError("max_leverage 要在 (0, 3] 之间；现金账户不加杠杆就用 1.0")
        if method not in ("har", "ewma"):
            raise ValueError('method 只能是 "har" 或 "ewma"')
        if not (1 <= int(horizon) <= 63):
            raise ValueError("horizon（预测几天）要在 1–63 之间")
        self.target, self.max_leverage, self.min_scale = float(target), float(max_leverage), float(min_scale)
        self.horizon, self.min_history, self.refit_every = int(horizon), max(int(min_history), 66), max(int(refit_every), 1)
        self.method, self.lam = method, float(ewma_lambda)
        self._dates, self._r2 = [], []          # 已经发生的日期和平方日收益
        self._cum = [0.0]                       # 平方收益的前缀和：_cum[i] = r2[0] + ... + r2[i-1]
        self._A = [[0.0] * 4 for _ in range(4)]  # 最小二乘的累加量（扩张窗口：新样本只加不改）
        self._b = [0.0] * 4
        self._nobs, self._next_i = 0, 21
        self._ewma = None                       # EWMA 方差
        self._coef, self._fit_at = None, -1      # 系数用到第几个交易日为止的数据（按固定日历重估，和何时调用无关）
        self.last_source = None                 # 最近一次预测用的是 "har" / "ewma" / None

    # --- 喂数据 ---
    def update(self, when, ret):
        """加一个交易日的简单收益（比如 0.01 = +1%）。日期必须严格递增；NaN / None 忽略。"""
        if ret is None:
            return
        r = float(ret)
        if not math.isfinite(r) or abs(r) > 1.0:
            return  # 单日超过 ±100% 视为坏数据
        d = _day(when)
        if self._dates and d <= self._dates[-1]:
            raise ValueError(f"HelmVol.update 的日期必须递增：{d} 不晚于 {self._dates[-1]}")
        self._dates.append(d)
        self._r2.append(r * r)
        self._cum.append(self._cum[-1] + r * r)
        self._ewma = r * r if self._ewma is None else self.lam * self._ewma + (1 - self.lam) * r * r

    def warmup(self, pairs):
        """批量 update：[(日期, 日收益), ...]，常用于 initialize 里用 history 预热。"""
        for d, r in pairs:
            self.update(d, r)

    # --- 预测 ---
    def _features(self, i):
        c = self._cum
        return (1.0, self._r2[i], (c[i + 1] - c[i - 4]) / 5.0, (c[i + 1] - c[i - 21]) / 22.0)

    def _fit(self, m):
        """扩张窗口最小二乘，只用前 m 个交易日：样本 i 的目标 = 第 i+1..i+h 天的平均平方收益，
        只加入目标窗口在第 m 天之前已经完整发生的 i。"""
        h, c = self.horizon, self._cum
        while self._next_i < m - h:
            i = self._next_i
            x = self._features(i)
            t = (c[i + 1 + h] - c[i + 1]) / h
            for a in range(4):
                self._b[a] += x[a] * t
                for bb in range(4):
                    self._A[a][bb] += x[a] * x[bb]
            self._nobs += 1
            self._next_i += 1
        if self._nobs < 60:
            return None
        k = 4
        A = [row[:] for row in self._A]
        b = self._b[:]
        scale = max(A[a][a] for a in range(k)) or 1.0
        for a in range(1, k):
            A[a][a] += 1e-8 * scale  # 极小的 ridge，只为数值稳定
        return _solve(A, b)

    def forecast(self):
        """未来 horizon 天的年化波动率预测；历史不足返回 None。"""
        n = len(self._r2)
        if n < 22 or self._ewma is None:
            self.last_source = None
            return None
        ewma_var = self._ewma
        var = None
        if self.method == "har" and n >= self.min_history:
            m = n - n % self.refit_every  # 每 refit_every 个交易日重估一次，时点只由日期序号决定
            if m != self._fit_at:
                self._coef, self._fit_at = self._fit(m), m
            if self._coef is not None:
                f = self._features(n - 1)
                v = sum(c * x for c, x in zip(self._coef, f))
                # 非正、或比 EWMA 离谱 10 倍以上的预测不用
                if v > 0 and ewma_var / 10 <= v <= ewma_var * 10:
                    var = v
        self.last_source = "har" if var is not None else "ewma"
        if var is None:
            var = ewma_var
        return math.sqrt(var * self.TRADING_DAYS)

    def scale(self):
        """仓位系数 = min(max_leverage, target / 预测波动率)，不低于 min_scale；没法预测时为 1（不调）。"""
        f = self.forecast()
        if f is None or f <= 0:
            return min(1.0, self.max_leverage)
        return max(self.min_scale, min(self.max_leverage, self.target / f))

    def info(self):
        f = self.forecast()
        return {"days": len(self._r2), "forecast": f, "source": self.last_source, "scale": self.scale(),
                "target": self.target, "max_leverage": self.max_leverage, "method": self.method, "horizon": self.horizon}


class HelmShortCost:
    """融券（借股）成本。LEAN 本地回测不收融券费，做空的策略回测会偏乐观；这个类按天把费用从现金里扣掉。

    费用 = |空头市值| × 年化费率 × 距上次扣费的自然日数 / 360（美股融券按自然日计息，周末也算）。
    rate：默认年化费率（容易借的大盘股约 0.25%–1%，默认 0.5%）；rates：{代码: 费率} 单独指定，
    hard_to_borrow：难借的代码集合，统一用 htb_rate（默认 10%，难借股常见 5%–50%+，宁可估高）。
    只读当时的持仓和价格，没有前视。charge() 同一天调用多次只扣一次。
    """
    DAY_COUNT = 360.0

    def __init__(self, rate=0.005, rates=None, hard_to_borrow=None, htb_rate=0.10):
        for name, v in (("rate", rate), ("htb_rate", htb_rate)):
            if not (0 <= float(v) <= 2):
                raise ValueError(f"{name} 是年化费率，比如 0.005 = 0.5%（范围 0–200%）")
        self.rate, self.htb_rate = float(rate), float(htb_rate)
        self.rates = {str(k).upper(): float(v) for k, v in (rates or {}).items()}
        for k, v in self.rates.items():
            if not (0 <= v <= 2):
                raise ValueError(f"{k} 的费率 {v} 不合理：要写年化小数，比如 0.03 = 3%")
        self.htb = {str(k).upper() for k in (hard_to_borrow or ())}
        self.total = 0.0
        self.by_symbol = {}
        self.days_short = 0                     # 有空头持仓、扣过费的交易日数
        self.max_short_value = 0.0              # 出现过的最大空头总市值
        self._last = None                       # 上次扣费的日期（date）

    def rate_for(self, ticker):
        t = str(ticker).upper()
        if t in self.rates:
            return self.rates[t]
        return self.htb_rate if t in self.htb else self.rate

    @staticmethod
    def _a(o, snake, pascal, default=None):
        v = getattr(o, snake, None)
        return getattr(o, pascal, default) if v is None else v

    @staticmethod
    def _shorts(algo):
        """[(代码, 空头市值的绝对值)]；兼容 LEAN 的 snake_case / PascalCase 和测试用的假对象。"""
        A = HelmShortCost._a
        pf = A(algo, "portfolio", "Portfolio")
        vals = pf.values() if hasattr(pf, "values") else pf.Values
        out = []
        for h in vals:
            if float(A(h, "quantity", "Quantity", 0)) >= 0:
                continue
            v = A(h, "holdings_value", "HoldingsValue", 0)
            sym = A(h, "symbol", "Symbol")
            tk = A(sym, "value", "Value") or str(sym)
            out.append((str(tk), abs(float(v))))
        return out

    @staticmethod
    def _debit(algo, amount):
        A = HelmShortCost._a
        pf = A(algo, "portfolio", "Portfolio")
        book = A(pf, "cash_book", "CashBook")
        if book is not None:
            try:
                c = book["USD"]
                A(c, "add_amount", "AddAmount")(-amount)
                return
            except Exception:  # noqa: BLE001  旧版 LEAN / 假对象：直接改现金
                pass
        A(pf, "set_cash", "SetCash")(float(A(pf, "cash", "Cash")) - amount)

    def charge(self, algo, when=None):
        """扣从上次扣费到今天的融券费，返回这次扣的金额。第一次调用按 1 天算。"""
        d = when if when is not None else self._a(algo, "time", "Time")
        d = datetime.strptime(_day(d), "%Y-%m-%d").date()
        if self._last is not None and d <= self._last:
            return 0.0
        days = 1 if self._last is None else (d - self._last).days
        self._last = d
        shorts = self._shorts(algo)
        if not shorts:
            return 0.0
        fee = 0.0
        for tk, mv in shorts:
            f = mv * self.rate_for(tk) * days / self.DAY_COUNT
            self.by_symbol[tk] = self.by_symbol.get(tk, 0.0) + f
            fee += f
        self.max_short_value = max(self.max_short_value, sum(mv for _, mv in shorts))
        self.days_short += 1
        if fee > 0:
            self._debit(algo, fee)
            self.total += fee
        return fee

    def summary(self):
        top = sorted(self.by_symbol.items(), key=lambda kv: -kv[1])[:5]
        return (f"融券成本合计 ${self.total:,.2f}（{self.days_short} 个有空头的交易日，最大空头市值 ${self.max_short_value:,.0f}；"
                f"默认费率 {self.rate:.2%}，难借 {self.htb_rate:.2%}）"
                + (f"；最多的：{', '.join(f'{k} ${v:,.0f}' for k, v in top)}" if top else ""))


def _solve(A, b):
    """小型线性方程组（高斯消元，部分选主元）。奇异时返回 None。"""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-300:
            return None
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] for i in range(n)]
