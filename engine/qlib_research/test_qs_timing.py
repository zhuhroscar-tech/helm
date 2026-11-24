"""Tests for qs_timing (market breadth + time-series test). Pure pandas/numpy, no qlib, no network.

    python -I engine/qlib_research/test_qs_timing.py
"""
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qs_timing as T  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    print(("PASS" if cond else "FAIL") + "  " + name + (f"  ({extra})" if extra else ""))
    if not cond:
        failed += 1


def write_zip(path: Path, closes: pd.Series):
    lines = [f"{d:%Y%m%d} 00:00,{int(round(c*10000))},{int(round(c*10000))},{int(round(c*10000))},{int(round(c*10000))},1000"
             for d, c in closes.items()]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(path.stem + ".csv", "\n".join(lines) + "\n")


idx = pd.bdate_range("2004-01-01", "2016-12-30")
rng = np.random.default_rng(3)

# ---- build_breadth on a hand-made case ----
c = pd.DataFrame({"A": np.linspace(10, 30, len(idx)), "B": np.linspace(30, 10, len(idx))}, index=idx)
for k in range(20):  # padding names: flat with tiny noise so MIN_MEMBERS is met
    c[f"P{k}"] = 50 + rng.normal(0, 0.01, len(idx)).cumsum()
elig = pd.DataFrame(True, index=idx, columns=c.columns)
b = T.build_breadth(c, elig)
d = idx[400]
row = b.loc[d]
check("pct_above_200 在 0–1 之间，成员数正确", 0 <= row["pct_above_200"] <= 1 and row["members"] == 22)
check("前 199 天没有 pct_above_200（均线不够长）", b["pct_above_200"].first_valid_index() >= idx[199])
elig2 = elig.copy(); elig2.loc[:, [f"P{k}" for k in range(20)]] = False
check("成员太少（< 20）就不给值", T.build_breadth(c, elig2)["pct_above_200"].dropna().empty)
# 不是成员的日子不能用
elig3 = elig.copy(); elig3.loc[idx[:500], "A"] = False
b3 = T.build_breadth(c, elig3)
check("不是成员的日子不计入", b3.loc[idx[450], "members"] == 21)

# ---- no look-ahead: value on d must not change when future prices change ----
c_future = c.copy(); c_future.loc[idx[1000]:, :] *= 3
b_f = T.build_breadth(c_future, elig)
check("没有前视：改未来价格不改变过去的宽度", np.allclose(b.loc[:idx[999]].fillna(-9).to_numpy(), b_f.loc[:idx[999]].fillna(-9).to_numpy()))

# ---- forward returns start the next day ----
bench = pd.Series(np.arange(1, len(idx) + 1, dtype=float), index=idx)
fr = T.forward_returns(bench, 5)
check("未来收益从第二天收盘开始算", abs(fr.iloc[0] - (bench.iloc[6] / bench.iloc[1] - 1)) < 1e-12)

# ---- time-series test: a planted signal is found; noise is not ----
ret = rng.normal(0.0003, 0.01, len(idx))
sig_plant = pd.Series(np.nan, index=idx)
# signal = future 21d return + noise (planted predictive power)
px = pd.Series(100 * np.exp(np.cumsum(ret)), index=idx)
f21 = T.forward_returns(px, 21)
sig_plant = (f21 + rng.normal(0, 0.02, len(idx))).fillna(0)
breadth = pd.DataFrame({"pct_above_200": sig_plant, "net_highs": rng.normal(0, 1, len(idx)), "dispersion": rng.normal(0, 1, len(idx))}, index=idx)
with tempfile.TemporaryDirectory() as tmp:
    reg = Path(tmp) / "reg.jsonl"
    r = T.run_test(breadth, px, "sp500", ["pct_above_200", "net_highs"], [21, 63], "2005-01-01", "2014-12-31", registry=reg)
    check("埋进去的信号能找到", r["series"]["pct_above_200"]["verdict"] == "signal", json.dumps(r["series"]["pct_above_200"]["reasons_zh"], ensure_ascii=False))
    check("纯噪声没有信号", r["series"]["net_highs"]["verdict"] != "signal", r["series"]["net_highs"]["verdict"])
    h21 = r["series"]["pct_above_200"]["horizons"][0]
    check("不重叠样本：n ≈ 天数 / 21", 100 <= h21["n"] <= 125, h21["n"])
    check("只用开发期", r["dev_window"] == ["2005-01-01", "2014-12-31"])
    check("登记了 4 个检验，门槛按 4 个算", r["tests_on_universe"] == 4 and abs(r["t_threshold"] - T.t_threshold(4)) < 1e-3)
    r2 = T.run_test(breadth, px, "sp500", ["dispersion"], [21], "2005-01-01", "2014-12-31", registry=reg)
    check("再测一个：门槛变高（5 个检验）", r2["tests_on_universe"] == 5 and r2["t_threshold"] > r["t_threshold"])
    r3 = T.run_test(breadth, px, "sp500", ["pct_above_200"], [21], "2005-01-01", "2014-12-31", registry=reg)
    check("重复同一个检验不重复登记", r3["tests_on_universe"] == 5)
    check("登记是只追加的", len(reg.read_text().strip().splitlines()) == 5)
    # 开发期以外的数据不影响结果
    px2 = px.copy(); px2.loc["2015-06-01":] *= 0.5
    r4 = T.run_test(breadth, px2, "other", ["pct_above_200"], [21], "2005-01-01", "2014-12-31", registry=reg)
    r5 = T.run_test(breadth, px, "other2", ["pct_above_200"], [21], "2005-01-01", "2014-12-31", registry=reg)
    check("验证期的价格不影响检验结果", r4["series"]["pct_above_200"]["horizons"][0]["ic"] == r5["series"]["pct_above_200"]["horizons"][0]["ic"])
    # 方向：dispersion 是越低越看好
    check("dispersion 的方向是 -1", T.SERIES["dispersion"]["direction"] == -1)
    try:
        T.run_test(breadth, px, "sp500", ["made_up"], [21], "2005-01-01", "2014-12-31", registry=reg)
        check("不认识的序列报错", False)
    except ValueError:
        check("不认识的序列报错", True)
    # 样本少：提醒
    r6 = T.run_test(breadth, px, "short", ["pct_above_200"], [63], "2012-01-01", "2014-12-31", registry=reg)
    check("独立样本少于 40：不能判有信号，并提醒", r6["series"]["pct_above_200"]["verdict"] != "signal" and "很难证明" in r6["summary_zh"])

    # ---- build_from_lean: files a universe export wrote ----
    data = Path(tmp) / "Data"
    (data / "helm" / "universes").mkdir(parents=True)
    (data / "equity" / "usa" / "daily").mkdir(parents=True)
    rows = []
    for k in range(25):
        t = f"T{k}"
        s = pd.Series(50 * np.exp(np.cumsum(rng.normal(0.0002, 0.01, len(idx)))), index=idx)
        write_zip(data / "equity" / "usa" / "daily" / f"{t.lower()}.zip", s)
        rows.append((t, "2004-01-01", "2016-12-30" if k else "2010-06-30"))
    rows.append(("BRK-B", "2004-01-01", "2016-12-30"))
    write_zip(data / "equity" / "usa" / "daily" / "brk.b.zip", pd.Series(100.0, index=idx))
    pd.DataFrame(rows, columns=["ticker", "start", "end"]).to_csv(data / "helm" / "universes" / "sp500.csv", index=False)
    meta = T.build_from_lean(data, "sp500")
    out = pd.read_csv(data / "helm" / "breadth" / "sp500.csv")
    check("从 LEAN 文件算出宽度并写 CSV + 说明", meta["rows"] == len(out) and meta["names_with_prices"] == 26 and (data / "helm" / "breadth" / "sp500.json").exists())
    check("退出指数后不再计入（T0 2010-06-30 退出）", int(out[out["date"] == "2012-01-03"]["members"].iloc[0]) == 25)
    check("LEAN 价格单位换算正确", abs(T.read_lean_daily(data / "equity" / "usa" / "daily" / "brk.b.zip").iloc[0] - 100.0) < 1e-9)
    try:
        T.build_from_lean(data, "nasdaq100")
        check("股票池没准备：报错", False)
    except FileNotFoundError:
        check("股票池没准备：报错", True)

# ---- HelmBreadth (LEAN side): only rows dated strictly before today ----
with tempfile.TemporaryDirectory() as tmp:
    os.makedirs(os.path.join(tmp, "helm", "breadth"))
    with open(os.path.join(tmp, "helm", "breadth", "sp500.csv"), "w") as f:
        f.write("date,pct_above_200,net_highs,dispersion,members\n2020-01-02,0.6,0.1,0.05,480\n2020-01-03,0.4,-0.2,0.07,481\n2020-01-06,,0.0,0.06,482\n")
    os.environ["HELM_LEAN_DATA"] = tmp
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    import helm_data as H
    br = H.HelmBreadth("sp500")
    check("HelmBreadth：当天的行当天看不到", br.value("2020-01-02") is None and br.value("2020-01-03") == 0.6)
    check("HelmBreadth：周末取前一个交易日之前的行", br.value("2020-01-04", "net_highs") == -0.2)
    check("HelmBreadth：缺值返回 None", br.value("2020-01-07") is None)
    try:
        br.value("2020-01-03", "bogus")
        check("HelmBreadth：不认识的字段报错", False)
    except ValueError:
        check("HelmBreadth：不认识的字段报错", True)
    check("HelmBreadth：数据过期给警告、不给旧值", br.value("2020-03-02") is None and any("市场宽度" in w for w in H.WARNINGS))
    check("HelmBreadth 在 __all__ 里", "HelmBreadth" in H.__all__)

print(f"\n{failed} 项失败" if failed else "\n全部通过")
sys.exit(1 if failed else 0)
