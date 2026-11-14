"""Helm <-> Qlib bridge. Runs with the Python that has qlib (see run.sh --which-python), never the LEAN venv.

Every research step stays inside the tested qlib research engine
(engine/qlib_research, formerly the quant-strategy skill). This file only reads its outputs and converts them to LEAN's
local data format, so price sources, point-in-time membership, date alignment and renames are exactly
the engine's.

  qlib_bridge.py universes                                  -> JSON: available stock universes
  qlib_bridge.py members  --index sp500 --date 2015-06-30   -> JSON: members on that day
  qlib_bridge.py export   --index sp500 --data <LEAN Data> --workdir <dir> [--start 2008-01-01] --status <file>
        runs the engine's universe+data phases, then writes
          <data>/equity/usa/daily/<t>.zip, map_files, factor_files  (adjusted OHLCV)
          <data>/helm/universes/<index>.csv   ticker,start,end   (days the name was a member AND priced)
          <data>/helm/universes/<index>.json  membership kind, coverage, notes
  qlib_bridge.py signals  --run <run dir> --data <LEAN Data> --name <name> [--feature F_EP | --idea-factor NAME]
          <data>/helm/signals/<name>.csv      date,ticker,score  (score known at that day's close)
          <data>/helm/signals/<name>.json     segments (dev walk-forward / holdout), model, verdict
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
import zipfile
from pathlib import Path

SCRIPTS = Path(os.environ.get("QS_SCRIPTS", Path(__file__).resolve().parent / "qlib_research"))
SHARED = os.path.expanduser("~/.qlib/qlib_data/us_data")
# Point-in-time membership files that extend Qlib's stale lists (built from Qlib + Wikipedia's change log;
# see the .json next to each file for provenance). Used automatically when present.
# Remaining data limitation of these universes, shown wherever they are offered. Measured on the export of
# 2026-11-08 (after the corrupt-series, wrong-company and cutoff fixes in qs_data / cmd_export); when an
# export's universe JSON carries its own measurement (gaps_by_year), data_warning() words it from that.
DATA_WARNINGS = {
    "sp500": "2021 年以后每年约 1%–8% 的成员日没有价格（2021 年 8%，2022 年 6%，2023 年 4%，2024 年 4%，2025 年 2%，2026 年 1%），"
             "其中约 86% 是 2020-11 之后被收购或退市、免费数据源没有后续价格的股票；它们在断点之后不算成员，所以 2021 年以后的结果可能偏乐观。"
             "损坏的旧价格序列和对应错公司的代码已经按规则剔除或修复，剔除的股票当作没有价格，不会用错的价格。",
    "nasdaq100": "2021 年以后每年约 2%–9% 的成员日没有价格（2021 年 9%，2022 年 6%，2023 年 5%，2024 年 4%，2025 年 3%，2026 年 2%），"
                 "其中约 87% 是 2020-11 之后被收购或退市、免费数据源没有后续价格的股票；它们在断点之后不算成员，所以 2021 年以后的结果可能偏乐观。"
                 "损坏的旧价格序列和对应错公司的代码已经按规则剔除或修复，剔除的股票当作没有价格，不会用错的价格。",
}
PIT_FILES = {"sp500": os.path.expanduser("~/.qlib/qs_cache/membership/sp500_pit.txt")}


def data_warning(key, exported=None):
    """The disclosure for a universe: worded from the export's measured member-day gaps when present."""
    if key not in DATA_WARNINGS:
        return None
    rows = [r for r in ((exported or {}).get("gaps_by_year") or []) if r.get("year", 0) >= 2021 and r.get("member_days")]
    if not rows:
        return DATA_WARNINGS[key]
    lo, hi = min(r["share"] for r in rows), max(r["share"] for r in rows)
    worst = max(rows, key=lambda r: r["share"])
    cut = sum(r["after_cutoff"] for r in rows) / max(sum(r["unpriced"] for r in rows), 1)
    span = f"{lo:.0%}" if round(lo * 100) == round(hi * 100) else f"{lo:.0%}–{hi:.0%}"
    return (f"2021 年以后每年约 {span} 的成员日没有价格（最多是 {worst['year']} 年的 {worst['share']:.0%}），"
            f"其中约 {cut:.0%} 是 2020-11 之后被收购或退市、免费数据源没有后续价格的股票；它们在断点之后不算成员，"
            "所以 2021 年以后的结果可能偏乐观。损坏的旧价格序列和对应错公司的代码已经按规则剔除或修复，"
            "剔除的股票当作没有价格，不会用错的价格。")


def pit_file(key):
    f = PIT_FILES.get(key)
    return f if f and os.path.exists(f) else None


def pit_info(key):
    f = pit_file(key)
    if not f:
        return None
    meta = Path(f).with_suffix(".json")
    return json.loads(meta.read_text()) if meta.exists() else {}
sys.path.insert(0, str(SCRIPTS))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import qs_membership as M  # noqa: E402

# The engine's aliases (kept in sync with qs_pipeline.ALIASES / BENCH_ALIAS)
INDEXES = {
    "sp500": {"label": "S&P 500", "target": "sp500", "bench": "SPY"},
    "nasdaq100": {"label": "纳斯达克 100", "target": "QQQ", "bench": "QQQ"},
    "dia": {"label": "道琼斯 30", "target": "DIA", "bench": "DIA"},
    "sox": {"label": "费城半导体", "target": "SOX", "bench": "SOXX"},
    "spy100": {"label": "S&P 100", "target": "spy100", "bench": "SPY"},
    "iwm80": {"label": "罗素 2000（80 只样本）", "target": "iwm80", "bench": "IWM"},
}


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, default=str))


def lean_symbol(t: str) -> str:
    return t.strip().upper().replace("-", ".").lower()


def write_status(path, **kw):
    if not path:
        return
    p = Path(path)
    cur = json.loads(p.read_text()) if p.exists() else {}
    cur.update(kw, updated=dt.datetime.now().isoformat(timespec="seconds"))
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(cur, ensure_ascii=False, indent=1, default=str))
    os.replace(tmp, p)


# ---------------------------------------------------------------------------
# universes / members
# ---------------------------------------------------------------------------

def cmd_universes(a):
    rows = []
    cal = Path(SHARED) / "calendars" / "day.txt"
    as_of = cal.read_text().split()[-1] if cal.exists() else None
    for key, info in INDEXES.items():
        f = Path(SHARED) / "instruments" / f"{('nasdaq100' if key == 'nasdaq100' else key)}.txt"
        n, kind, member_as_of, pit = None, "snapshot", None, None
        if f.exists():
            iv = M._read_intervals(f)
            n = int(iv.ticker.nunique())
            kind = "partial-point-in-time" if M._has_history(iv) else "snapshot"
            member_as_of = M.last_change(iv) if kind == "partial-point-in-time" else None
        exp = Path(a.data) / "helm" / "universes" / f"{key}.json" if a.data else None
        if key == "nasdaq100":
            # resolved live from Nasdaq's official weighting endpoint by the engine: as of the last export
            kind = "point-in-time"
            member_as_of = (json.loads(exp.read_text()).get("as_of") if exp and exp.exists() else None)
        pit = pit_info(key)
        if pit is not None:
            kind, member_as_of = "point-in-time", pit.get("as_of")
            n = pit.get("tickers_ever", n)
        exp = Path(a.data) / "helm" / "universes" / f"{key}.json" if a.data else None
        exported = json.loads(exp.read_text()) if exp and exp.exists() else None
        rows.append({"key": key, **info, "kind": kind, "names_ever": n, "qlib_as_of": member_as_of or as_of, "prices_as_of": as_of,
                     "data_warning": data_warning(key, exported),
                     "membership_source": ("Qlib 到 2020-10 + Wikipedia 成分股变更表（未经价格核对）" if pit is not None else None),
                     "exported": exported})
    out({"universes": rows, "shared_store": SHARED, "calendar_end": as_of})


def cmd_members(a):
    key = a.index.lower()
    info = INDEXES.get(key)
    if not info:
        raise SystemExit(f"unknown index {a.index}; choose from {', '.join(INDEXES)}")
    d = pd.Timestamp(a.date)
    target = {"nasdaq100": "qqq"}.get(key, key)
    mem = M.resolve(target, None, pit_file(key), SHARED, "2008-01-01", pd.Timestamp.today().normalize(), log=lambda *_: None)
    iv = mem["intervals"]
    on = sorted(iv[(iv.start <= d) & (iv.end >= d)].ticker.unique())
    out({"index": key, "date": str(d.date()), "kind": mem["kind"], "as_of": mem["as_of"], "source": mem["source"],
         "notes": mem["notes"], "count": len(on), "members": on})


# ---------------------------------------------------------------------------
# export: engine universe+data phases -> LEAN files
# ---------------------------------------------------------------------------

def read_bins(uri: str, t: str):
    df = M.read_shared_bin(uri, t)
    if df is None:
        return None
    return df.dropna(subset=["open", "high", "low", "close"])


def lean_rows(df: pd.DataFrame) -> list[str]:
    """整张表一次算完（和逐行 iterrows 结果完全一样：np.rint 与 round 都是四舍六入五成双），S&P 500 全量导出快约 10 倍。"""
    o, h, l, c = (np.rint(df[k].to_numpy(dtype="float64") * 10000).astype("int64") for k in ("open", "high", "low", "close"))
    h = np.maximum(np.maximum(h, o), c)
    l = np.minimum(np.minimum(l, o), c)
    vol = df["volume"].to_numpy(dtype="float64")
    v = np.where(np.isnan(vol), 0, np.trunc(np.nan_to_num(vol))).astype("int64")
    d = pd.DatetimeIndex(df.index).strftime("%Y%m%d")
    return [f"{d[i]} 00:00,{o[i]},{h[i]},{l[i]},{c[i]},{v[i]}" for i in range(len(o))]


def spells_of(col: pd.Series):
    """Consecutive True runs of a boolean Series indexed by date -> [(start, end)]."""
    v = col.values.astype(bool)
    idx = col.index
    out_, start = [], None
    for i, x in enumerate(v):
        if x and start is None:
            start = idx[i]
        if not x and start is not None:
            out_.append((start, idx[i - 1]))
            start = None
    if start is not None:
        out_.append((start, idx[-1]))
    return out_


PHASES_AFTER_ENV = ("universe", "data", "design", "features", "factors", "model", "robustness", "advanced",
                    "portfolio", "overlay", "holdout", "report")


def _reset_data_phases(run_dir: Path):
    """A re-export must rebuild membership and prices with the current engine: mark the universe phase and
    everything after it as pending (the engine then overwrites those outputs; nothing is deleted)."""
    ph = run_dir / "phase_status.json"
    if not ph.exists():
        return
    st = json.loads(ph.read_text())
    for p in PHASES_AFTER_ENV:
        if p in st:
            st[p] = {"status": "pending"}
    tmp = ph.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=1))
    os.replace(tmp, ph)


def _store_cutoffs(root=SHARED):
    """Dates on which most series of the shared Qlib store end together (the store's own end dates)."""
    import qs_data as Dq
    root = Path(root)
    calf = root / "calendars" / "day.txt"
    if not calf.exists():
        return []
    cal = pd.DatetimeIndex(pd.to_datetime(calf.read_text().split()))
    ends = []
    for fdir in (root / "features").iterdir():
        p = fdir / "close.day.bin"
        if p.exists():
            v = np.fromfile(p, dtype="<f4")
            ok = np.where(np.isfinite(v[1:]))[0]
            if len(ok):
                ends.append(cal[min(int(v[0]) + int(ok[-1]), len(cal) - 1)])
    return Dq.store_cutoffs(ends)


def _lean_scale(df: pd.DataFrame):
    """Shared-store prices are in Qlib's scaled units (often ~1 at listing, some far below 0.1); LEAN stores
    price*10000 as an integer, so tiny levels lose precision. Scale by a power of ten (returns unchanged)."""
    lo = float(df["close"].min())
    if not lo > 0 or lo >= 1:
        return df, 1
    k = 10 ** int(np.ceil(-np.log10(lo)))
    df = df.copy()
    df[["open", "high", "low", "close"]] *= k
    df["volume"] = df["volume"] / k
    return df, k


def _quality_overview(prov: dict, used: set):
    """What the engine's quality and identity rules did, per category (tickers sorted)."""
    cat = {"corrupt_series_rejected": [], "corrupt_spans_removed": [], "wrong_company_rejected": [],
           "curated_identity": [], "cut_after_acquisition": [], "merged_sources": []}
    for t, p in sorted(prov.items()):
        rej = p.get("rejected") or {}
        if any(v.startswith("corrupt") for v in rej.values()):
            cat["corrupt_series_rejected"].append(t)
        q = (p.get("quality") or {}).get(p.get("source"), {})
        if t in used and (q.get("spikes") or q.get("excluded")):
            cat["corrupt_spans_removed"].append(t)
        if any(v.startswith("identity") for v in rej.values()):
            cat["wrong_company_rejected"].append(t)
        if any(v.startswith("curated") for v in rej.values()):
            cat["curated_identity"].append(t)
        if p.get("cut"):
            cat["cut_after_acquisition"].append(t)
        if p.get("merged"):
            cat["merged_sources"].append(t)
    return {k: {"count": len(v), "tickers": v[:150]} for k, v in cat.items()}


def cmd_export(a):
    import qs_data as Dq
    key = a.index.lower()
    info = INDEXES.get(key)
    if not info:
        raise SystemExit(f"unknown index {a.index}")
    status = a.status
    write_status(status, index=key, status="running", phase="成分股和价格（qlib 引擎）", progress=0.05,
                 started=dt.datetime.now().isoformat(timespec="seconds"), error=None, pid=os.getpid())
    name = f"HELM_{key.upper()}"
    run_id = dt.date.today().strftime("%Y%m%d")
    wd = Path(a.workdir)
    wd.mkdir(parents=True, exist_ok=True)
    cmd = [str(SCRIPTS / "run.sh"), "run", "--target", info["target"], "--name", name, "--run-id", run_id,
           "--benchmark", info["bench"], "--start", a.start, "--stop-after", "data", "--advanced", "off",
           "--workdir", str(wd)]
    if pit_file(key):
        cmd += ["--membership-file", pit_file(key)]
    run_dir = wd / "quant_runs" / f"{name}_{run_id}"
    _reset_data_phases(run_dir)  # a second export on the same day must not reuse the earlier data phase
    log_path = wd / f"{name}_{run_id}.log"
    with open(log_path, "a") as lf:
        p = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT)
        while p.poll() is None:
            time.sleep(3)
            ph = run_dir / "phase_status.json"
            if ph.exists():
                st = json.loads(ph.read_text())
                if st.get("data", {}).get("status") == "running":
                    write_status(status, phase="下载/对齐价格（qlib 引擎，股票多时要几分钟）", progress=0.3)
                elif st.get("universe", {}).get("status") == "running":
                    write_status(status, phase="解析历史成分股", progress=0.1)
    st = json.loads((run_dir / "phase_status.json").read_text()) if (run_dir / "phase_status.json").exists() else {}
    if st.get("data", {}).get("status") != "complete":
        err = next((v.get("error") for v in st.values() if v.get("status") == "failed"), None)
        tail = log_path.read_text()[-1500:] if log_path.exists() else ""
        write_status(status, status="failed", phase=None, error=err or tail or "qlib 引擎没有完成数据阶段")
        raise SystemExit(1)

    write_status(status, phase="写入 LEAN 数据", progress=0.75)
    uni = json.loads((run_dir / "universe.json").read_text())
    audit = json.loads((run_dir / "data_audit.json").read_text())
    uri = audit["provider_uri"]
    eligible = pd.read_pickle(run_dir / "data" / "eligible.pkl")
    data = Path(a.data)
    base = data / "equity" / "usa"
    for sub in ("daily", "map_files", "factor_files"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    meta_path = data / "helm-meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    cal_end = pd.Timestamp(audit["calendar_end"])
    prov = audit.get("source_provenance", {})
    renames = audit.get("renames_detail", {})
    cutoffs = _store_cutoffs()
    written, skipped, delisted, gaps, scaled, stale = 0, 0, [], {}, [], []
    names = list(uni["tickers"]) + ([uni["benchmark_etf"]] if uni.get("benchmark_etf") else [])
    stale_dir = wd / "stale_lean_files" / run_id / key
    for i, t in enumerate(dict.fromkeys(names)):
        eff = renames[t]["to"] if t in renames else t
        src = (prov.get(eff) or {}).get("source", "")
        df = read_bins(uri, t)  # the engine writes renamed symbols into its provider too
        sym = lean_symbol(t)
        m = meta.get(sym)
        zpath = base / "daily" / f"{sym}.zip"
        if df is None or df.empty:
            # No usable series any more (rejected as corrupt or another company): an earlier export's files for
            # this name would still feed LEAN the wrong prices. Move them aside (not deleted).
            if m and m.get("universe") == key and str(m.get("source", "")).startswith("qlib"):
                stale_dir.mkdir(parents=True, exist_ok=True)
                for f in (zpath, base / "map_files" / f"{sym}.csv", base / "factor_files" / f"{sym}.csv"):
                    if f.exists():
                        os.replace(f, stale_dir / f"{f.parent.name}__{f.name}")
                meta.pop(sym, None)
                stale.append(t)
            continue
        # Helm's own Yahoo download has the full history of a listed name: keep it when the engine used exactly that.
        if m and m.get("source") == "yahoo-adjusted" and src == "yahoo" and zpath.exists() and t not in renames \
                and not (prov.get(t) or {}).get("merged"):
            skipped += 1
            continue
        shared_like = src.startswith("shared")
        df, k = _lean_scale(df) if shared_like else (df, 1)
        if k != 1:
            scaled.append(t)
        lines = lean_rows(df)
        tmp = zpath.with_suffix(".zip.tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{sym}.csv", "\n".join(lines) + "\n")
        os.replace(tmp, zpath)
        first, last = df.index[0], df.index[-1]
        # A series that stops where a data source stops (Qlib's store: 2020-11-10) is a data gap, not a delisting:
        # the stock kept trading, only the free data ended. Only a real end gets a delisting date in the map file.
        kind = Dq.end_kind(last, cal_end, cutoffs if shared_like else ())
        if kind == "delisted":
            delisted.append(t)
        elif kind == "gap":
            gaps[t] = str(last.date())
        end_row = f"{last:%Y%m%d}" if kind == "delisted" else "20501231"
        (base / "map_files" / f"{sym}.csv").write_text(f"{first:%Y%m%d},{sym},Q\n{end_row},{sym},Q\n")
        (base / "factor_files" / f"{sym}.csv").write_text(f"{first:%Y%m%d},1,1,1\n20501231,1,1,0\n")
        meta[sym] = {"start": str(first.date()), "end": str(last.date()), "rows": len(lines), "fetchedAt": time.time(),
                     "source": "qlib-shared" if src.startswith("shared") else "qlib-yahoo", "universe": key,
                     "end_kind": kind, **({"price_scale": k} if k != 1 else {}), **({"renamed_to": eff} if t in renames else {})}
        written += 1
        if i % 50 == 0:
            write_status(status, progress=0.75 + 0.2 * i / max(len(names), 1))
    tmp = meta_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=1))
    os.replace(tmp, meta_path)

    # Universe file: a name counts on a day only if it was a member AND priced (the engine's eligibility).
    rows = []
    for t in eligible.columns:
        for s, e in spells_of(eligible[t]):
            rows.append((t.replace("-", "."), f"{s:%Y-%m-%d}", f"{e:%Y-%m-%d}"))
    udir = data / "helm" / "universes"
    udir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows, columns=["ticker", "start", "end"]).sort_values(["ticker", "start"]).to_csv(udir / f"{key}.csv", index=False)
    per_day = eligible.sum(axis=1)
    iv = pd.read_csv(run_dir / "data" / "membership.csv", parse_dates=["start", "end"])
    member = M.member_matrix(iv, eligible.index, list(eligible.columns))
    gap_rows = Dq.member_gaps_by_year(member, eligible, {t: d for t, d in gaps.items() if t in eligible.columns})
    used = {t for t in eligible.columns if eligible[t].any()}
    summary = {
        "index": key, "label": info["label"], "benchmark": info["bench"],
        "membership_kind": uni["membership_kind"], "membership_source": uni["source"], "as_of": uni.get("as_of"),
        "survivorship_note": uni.get("survivorship_note"), "membership_notes": uni.get("membership_notes", []),
        "names_ever": uni["n"], "names_with_prices": int(eligible.any().sum()),
        "missing": audit.get("missing", [])[:200], "coverage": audit.get("member_day_coverage"),
        "members_per_day": {"min": int(per_day.min()), "median": int(per_day.median()), "max": int(per_day.max())},
        "start": audit["calendar_start"], "end": audit["calendar_end"],
        "uncertain_corrections": len(audit.get("uncertain_corrections", [])),
        "delisted_with_map_end": len(delisted), "files_written": written, "files_kept_from_yahoo": skipped,
        "data_gaps": {"count": len(gaps), "source_cutoffs": [str(c.date()) for c in cutoffs], "tickers": dict(sorted(gaps.items())),
                      "note": "price series stops where the free data source stops (not a delisting): no delisting date in the "
                              "map file; the name is not a member after its last price"},
        "gaps_by_year": gap_rows,
        "data_quality": _quality_overview(prov, used),
        "price_scaled_for_lean": {"count": len(scaled), "tickers": scaled[:150],
                                  "note": "shared-store prices are Qlib's scaled units, not traded prices; multiplied by a power of ten for LEAN precision"},
        "stale_files_moved": {"count": len(stale), "tickers": stale, "to": str(stale_dir) if stale else None},
        "exported": dt.datetime.now().isoformat(timespec="seconds"), "engine_run": str(run_dir),
        "csv": f"helm/universes/{key}.csv",
    }
    (udir / f"{key}.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=str))
    write_status(status, status="complete", phase=None, progress=1, summary=summary)
    out(summary)


# ---------------------------------------------------------------------------
# signals: walk-forward model scores (or one factor) -> CSV for LEAN
# ---------------------------------------------------------------------------

def _long(s: pd.Series, seg: str) -> pd.DataFrame:
    s = s.dropna()
    if s.index.names[0] != "datetime":
        s = s.swaplevel()
    df = s.rename("score").reset_index()
    df.columns = ["date", "ticker", "score"]
    df["segment"] = seg
    return df


def cmd_signals(a):
    rd = Path(a.run)
    res = rd / "results"
    frames, used = [], []
    idea_fac, idea_res, idea_cfg = None, None, None
    if getattr(a, "idea_factor", None):
        # Idea test factor: a fixed formula (nothing fitted), so every date the run's data covers is
        # exported, dev and holdout; scores are ranks among that day's eligible members (higher = buy).
        import qs_idea as I
        s, idea_fac, idea_cfg = I.factor_scores(rd, a.idea_factor)
        hs = json.loads((rd / "splits.json").read_text()).get("holdout_start")
        d = s.index.get_level_values(0)
        for seg, part in (("dev", s[d < pd.Timestamp(hs)]), ("holdout", s[d >= pd.Timestamp(hs)])):
            if len(part):
                frames.append(_long(part, seg))
        used.append(f"idea factor {idea_fac['name']}")
        ij = rd / "idea.json"
        if ij.exists():
            idea_res = next((f for f in json.loads(ij.read_text()).get("factors", []) if f.get("name") == idea_fac["name"]), None)
    elif a.feature:
        feat = pd.read_pickle(rd / "data" / "features.pkl")
        col = next((c for c in feat.columns if str(c[-1] if isinstance(c, tuple) else c).upper() == a.feature.upper()), None)
        if col is None:
            raise SystemExit(f"feature {a.feature} not in this run")
        s = feat[col]
        frames.append(_long(s, "factor"))
        used.append(f"factor {a.feature}")
    else:
        dev = res / "pred_dev_selected.pkl"
        if not dev.exists():
            dev = res / "pred_dev.pkl"
        if not dev.exists():
            raise SystemExit("这次研究还没有模型预测（model 阶段没完成）")
        frames.append(_long(pd.read_pickle(dev), "dev"))
        used.append(dev.name)
        ho = res / "pred_holdout.pkl"
        if ho.exists():
            frames.append(_long(pd.read_pickle(ho), "holdout"))
            used.append(ho.name)
    df = pd.concat(frames).sort_values(["date", "ticker"])
    df["ticker"] = df["ticker"].astype(str).str.upper().str.replace("-", ".", regex=False)
    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    df["score"] = df["score"].astype(float).round(6)
    sdir = Path(a.data) / "helm" / "signals"
    sdir.mkdir(parents=True, exist_ok=True)
    df[["date", "ticker", "score"]].to_csv(sdir / f"{a.name}.csv", index=False)

    def js(n):
        p = rd / n
        return json.loads(p.read_text()) if p.exists() else {}
    sp, fa, pf, ho, uni = js("splits.json"), js("factors.json"), js("portfolio.json"), js("holdout_results.json"), js("universe.json")
    seg = {k: {"start": g.date.min(), "end": g.date.max(), "rows": int(len(g))} for k, g in df.groupby("segment")}
    meta = {
        "name": a.name, "source_run": str(rd), "files": used, "kind": "factor" if a.feature else "model",
        "feature": a.feature, "segments": seg, "horizon_days": fa.get("horizon"),
        "holdout": {"start": sp.get("holdout_start"), "end": sp.get("end")} if sp else None, "universe": uni.get("target"), "membership_kind": uni.get("membership_kind"),
        "suggested_portfolio": {**(pf.get("chosen") or {}), "rebalance_every_days": pf.get("rebalance_every_days")} if pf else None,
        "verdict": ho.get("verdict"), "rows": int(len(df)), "tickers": int(df.ticker.nunique()),
        **({"kind": "idea", "horizon_days": (idea_res or {}).get("best_horizon"), "suggested_portfolio": None,
            "verdict": f"想法检验（只看开发期）：{idea_res['verdict_zh']}" if idea_res else None,
            "idea_factor": {k: idea_fac[k] for k in ("name", "label", "components", "hash")},
            "idea": (idea_cfg.get("idea") or {}).get("idea"), "idea_verdict": (idea_res or {}).get("verdict"),
            "source_job": rd.name.rsplit("_", 1)[-1] if "_" in rd.name else rd.name,
            "score_note": "per-day percentile rank (0-1] among that day's eligible index members; higher = buy"}
           if idea_fac else {}),
        "timing": "score dated D uses data up to D's close; trade it on the next trading day (HelmSignals.latest does this)",
        "exported": dt.datetime.now().isoformat(timespec="seconds"), "csv": f"helm/signals/{a.name}.csv",
    }
    (sdir / f"{a.name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, default=str))
    out(meta)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["universes", "members", "export", "signals"])
    ap.add_argument("--index")
    ap.add_argument("--date")
    ap.add_argument("--data")
    ap.add_argument("--workdir")
    ap.add_argument("--start", default="2008-01-01")
    ap.add_argument("--status")
    ap.add_argument("--run")
    ap.add_argument("--name")
    ap.add_argument("--feature")
    ap.add_argument("--idea-factor", help="signals: export this idea-test factor's daily scores")
    a = ap.parse_args()
    try:
        {"universes": cmd_universes, "members": cmd_members, "export": cmd_export, "signals": cmd_signals}[a.cmd](a)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        if a.cmd == "export":
            write_status(a.status, status="failed", phase=None, error=f"{type(e).__name__}: {e}")
        out({"error": f"{type(e).__name__}: {e}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
