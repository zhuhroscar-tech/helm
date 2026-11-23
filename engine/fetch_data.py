"""把 Yahoo Finance 的免费日线数据转换成 LEAN 本地数据格式。

用法: python fetch_data.py <data_folder> TICKER [TICKER ...] [--force] [--min-end=YYYY-MM-DD]

--min-end：数据最后一天早于这个日期就重新下载（qlib 导出的退市代码除外）。模拟实盘每天用它拿最新收盘价。
盘中下载时，今天还没收盘的那根日线会被丢掉，不会写进共享数据。

写入:
  <data>/equity/usa/daily/<t>.zip       (内含 <t>.csv: "yyyyMMdd 00:00,O*1e4,H*1e4,L*1e4,C*1e4,V")
  <data>/equity/usa/map_files/<t>.csv
  <data>/equity/usa/factor_files/<t>.csv (价格已复权，因子恒为 1)
  <data>/helm-meta.json                  (每个代码的数据区间和更新时间)
输出一行 JSON 结果到 stdout。
"""
import json
import os
import random
import shutil
import sys
import time
import zipfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

try:
    import yfinance as yf
except ImportError:  # 没装依赖时给一句能照着做的话，而不是一串 Traceback
    print(json.dumps({"results": [], "error": "engine/.venv 里没有 yfinance：在 Helm 安装目录运行 scripts/setup.sh"}, ensure_ascii=False))
    sys.exit(1)

STALE_SECONDS = 20 * 3600


def lean_symbol(ticker: str) -> str:
    # Yahoo 用 BRK-B，LEAN 用 brk.b
    return ticker.strip().upper().replace("-", ".").lower()


def yahoo_symbol(ticker: str) -> str:
    return ticker.strip().upper().replace(".", "-")


def load_meta(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def lean_lines(df, cols, drop_nonpositive=False):
    """一次处理整张表，生成 LEAN 日线行（价格 × 10000 取整）。
    和逐行 iterrows 的结果完全一样（np.rint 和 Python 的 round 都是四舍六入五成双），但快约 10 倍。
    drop_nonpositive：复权后价格为 0 或负数（很早以前、分红很多的股票）不是能成交的价格，跳过。"""
    import numpy as np
    o, h, l, c = (np.rint(df[k].to_numpy(dtype="float64") * 10000).astype("int64") for k in cols[:4])
    keep = np.minimum(np.minimum(o, h), np.minimum(l, c)) > 0 if drop_nonpositive else np.ones(len(o), dtype=bool)
    h = np.maximum(np.maximum(h, o), c)  # 复权和取整后偶尔会出现最高价低于收盘价
    l = np.minimum(np.minimum(l, o), c)
    vol = df[cols[4]].to_numpy(dtype="float64")
    v = np.where(np.isnan(vol), 0, np.trunc(np.nan_to_num(vol))).astype("int64")
    d = df.index.strftime("%Y%m%d")
    return [f"{d[i]} 00:00,{o[i]},{h[i]},{l[i]},{c[i]},{v[i]}" for i in np.flatnonzero(keep)]


def ny_now():
    return datetime.now(ZoneInfo("America/New_York"))


# Yahoo 限流 / 网络抖动时重试：每个代码最多 4 次，等待 2s、4s、8s（加一点随机）；整个进程的等待合计不超过 90 秒，
# 免得几十个代码一起被限流时超过调用方的 5 分钟超时。HELM_FETCH_BACKOFF 可以改基础等待（测试用）
MAX_TRIES = 4
BACKOFF = float(os.environ.get("HELM_FETCH_BACKOFF", "2"))
WAIT_BUDGET = [90.0]


class FetchError(Exception):
    pass


def transient_kind(e):
    """'throttle' = 被限流；'network' = 连不上 / 超时；None = 不值得重试的错误。"""
    name, msg = type(e).__name__, str(e)
    if "RateLimit" in name or "Too Many Requests" in msg or "429" in msg or "rate limit" in msg.lower():
        return "throttle"
    low = msg.lower()
    if isinstance(e, (TimeoutError, ConnectionError)) or any(k in name for k in ("Timeout", "Connection", "SSLError", "ProxyError")) \
            or any(k in low for k in ("timed out", "timeout", "connection", "temporarily unavailable", "name resolution", "502", "503", "504")):
        return "network"
    return None


def download_history(ticker, history=None, sleep=time.sleep):
    """下载整段复权日线，遇到限流 / 网络问题按指数退避重试；最后仍失败就抛出说清原因的 FetchError。
    空结果也重试一次（Yahoo 被限流时有时直接返回空表）。"""
    history = history or (lambda sym: yf.Ticker(sym).history(period="max", interval="1d", auto_adjust=True, actions=False))
    sym = yahoo_symbol(ticker)
    last_kind, last_err, empty_retried = None, None, False
    for attempt in range(MAX_TRIES):
        try:
            df = history(sym)
            if df is not None and not df.empty:
                return df
            if empty_retried:
                return df
            empty_retried, last_kind, last_err = True, "empty", None
        except Exception as e:  # noqa: BLE001
            kind = transient_kind(e)
            if kind is None:
                raise
            last_kind, last_err = kind, e
        if attempt == MAX_TRIES - 1:
            break
        wait = min(BACKOFF * (2 ** attempt) * (1 + 0.25 * random.random()), WAIT_BUDGET[0])
        if wait <= 0 and last_kind != "empty":
            break
        WAIT_BUDGET[0] -= wait
        sleep(wait)
    if last_kind == "empty":
        return None
    if last_kind == "throttle":
        raise FetchError(f"Yahoo Finance 限流（请求太多），重试 {MAX_TRIES} 次仍失败：等几分钟后再运行一次")
    raise FetchError(f"连不上 Yahoo Finance（{str(last_err)[:120]}），重试 {MAX_TRIES} 次仍失败：检查网络 / 代理后再试")


def fetch_one(data, ticker, meta, force, min_end=None):
    sym = lean_symbol(ticker)
    base = os.path.join(data, "equity", "usa")
    zpath = os.path.join(base, "daily", f"{sym}.zip")
    m = meta.get(sym)
    # qlib 导出的已退市/改名代码：Yahoo 上同名代码可能已经是另一家公司，绝不覆盖
    # qlib-yahoo 导出里已退市 / 数据中断 / 改过名的代码也一样（引擎截断、合并、清洗过），重新下载会换成别家公司的行情；
    # 仍在交易的 qlib-yahoo 代码照常刷新，否则模拟盘拿不到新数据
    protected = m and (m.get("source") == "qlib-shared" or (str(m.get("source", "")).startswith("qlib")
                                                           and (m.get("end_kind") in ("delisted", "gap") or m.get("renamed_to"))))
    if not force and protected and os.path.exists(zpath):
        return {"ticker": sym.upper(), "status": "cached", "start": m["start"], "end": m["end"], "rows": m["rows"]}
    fresh_enough = not min_end or (m and m.get("end", "") >= min_end)
    if not force and m and fresh_enough and time.time() - m.get("fetchedAt", 0) < STALE_SECONDS and os.path.exists(zpath):
        return {"ticker": sym.upper(), "status": "cached", "start": m["start"], "end": m["end"], "rows": m["rows"]}

    df = download_history(ticker)
    if df is None or df.empty:
        return {"ticker": sym.upper(), "status": "error", "error": "Yahoo 没有这个代码的数据"}
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    # 今天还没收盘（美东 16:15 之前）的那根是盘中价，不能当日线收盘价
    now = ny_now()
    if len(df) and now.strftime("%H:%M") < "16:15" and df.index[-1].strftime("%Y-%m-%d") == now.strftime("%Y-%m-%d"):
        df = df.iloc[:-1]
    lines = lean_lines(df, ("Open", "High", "Low", "Close", "Volume"), drop_nonpositive=True)
    if not lines:
        return {"ticker": sym.upper(), "status": "error", "error": "清洗后没有有效数据"}

    os.makedirs(os.path.dirname(zpath), exist_ok=True)
    tmp = f"{zpath}.{os.getpid()}.tmp"  # 几个下载进程同时跑时不能共用临时文件名
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{sym}.csv", "\n".join(lines) + "\n")
    os.replace(tmp, zpath)

    # LEAN 自带的样例数据里，部分代码有到 2021 年为止、未复权的小时/分钟数据，和复权日线冲突，删掉。
    for res in ("minute", "second", "tick"):
        stale = os.path.join(base, res, sym)
        if os.path.isdir(stale):
            shutil.rmtree(stale, ignore_errors=True)
    # LEAN 回测时基准（benchmark）固定读小时数据（Engine/DataFeeds/UniverseSelection.cs），
    # 所以用日线合成一份“每天一根、15:00”的小时文件，只给基准用；策略本身只能用日线。
    hpath = os.path.join(base, "hour", f"{sym}.zip")
    os.makedirs(os.path.dirname(hpath), exist_ok=True)
    htmp = f"{hpath}.{os.getpid()}.tmp"
    with zipfile.ZipFile(htmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{sym}.csv", "\n".join(l[:9] + "15:00" + l[14:] for l in lines) + "\n")
    os.replace(htmp, hpath)

    first = lines[0][:8]
    os.makedirs(os.path.join(base, "map_files"), exist_ok=True)
    os.makedirs(os.path.join(base, "factor_files"), exist_ok=True)
    with open(os.path.join(base, "map_files", f"{sym}.csv"), "w") as f:
        f.write(f"{first},{sym},Q\n20501231,{sym},Q\n")
    with open(os.path.join(base, "factor_files", f"{sym}.csv"), "w") as f:
        f.write(f"{first},1,1,1\n20501231,1,1,0\n")

    start = f"{first[:4]}-{first[4:6]}-{first[6:]}"
    last = lines[-1][:8]
    end = f"{last[:4]}-{last[4:6]}-{last[6:]}"
    meta[sym] = {"start": start, "end": end, "rows": len(lines), "fetchedAt": time.time(), "source": "yahoo-adjusted"}
    return {"ticker": sym.upper(), "status": "updated", "start": start, "end": end, "rows": len(lines)}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    min_end = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--min-end=")), None)
    if len(args) < 2:
        print(json.dumps({"error": "用法: fetch_data.py <data_folder> TICKER ..."}))
        sys.exit(2)
    data, tickers = args[0], list(dict.fromkeys(t for t in args[1:] if t.strip()))
    meta_path = os.path.join(data, "helm-meta.json")
    meta = load_meta(meta_path)
    results = []
    for t in tickers:
        try:
            results.append(fetch_one(data, t, meta, force, min_end))
        except Exception as e:  # 单个代码失败不影响其他代码
            results.append({"ticker": t.upper(), "status": "error", "error": str(e)[:300]})
    # 写回前重新读一次，合并别的下载进程这段时间写进去的条目
    merged = load_meta(meta_path)
    merged.update({k: v for k, v in meta.items() if k.upper() in {r.get("ticker", "").upper() for r in results if r.get("status") == "updated"} or k not in merged})
    mtmp = f"{meta_path}.{os.getpid()}.tmp"
    with open(mtmp, "w") as f:
        json.dump(merged, f, indent=1)
    os.replace(mtmp, meta_path)
    print(json.dumps({"results": results, "at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
