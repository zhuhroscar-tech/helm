#!/usr/bin/env python3
"""quant-strategy pipeline engine, resumable phase by phase.

The env / universe / data / design / idea phases (idea tests and universe exports) need only numpy and pandas:
formulas are evaluated by qs_expr and prices are read straight from the run's data directory. The full
research phases (features .. report: LightGBM, Qlib's backtest engine) still need qlib, imported on first use.

Usage (normally via run.sh, which picks the Python):
  run.sh run    --target QQQ [--workdir DIR] [options]
  run.sh status --target QQQ [--workdir DIR]

Every phase writes its outputs atomically into <workdir>/quant_runs/<NAME>/ and is
recorded in phase_status.json. Re-running the same command resumes at the first
phase that is not complete. Research-defining options are frozen in config.json
on the first run; changing them on a resume is refused (use --run-id for a new run).
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("MPLCONFIGDIR", os.path.join(os.path.expanduser("~"), ".cache", "quant-strategy", "mpl"))
# Never import a `qlib/` source folder that happens to sit in the working directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path = [_HERE] + [p for p in sys.path if p not in ("", ".", os.getcwd(), _HERE)]

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import platform  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
from collections import Counter  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import qs_core as C  # noqa: E402
import qs_membership as M  # noqa: E402
import qs_data as Dq  # noqa: E402
import qs_describe as W  # noqa: E402
import qs_idea as IDEA  # noqa: E402  (idea test: user factors, dev period only)
import qs_expr as X  # noqa: E402  (formula evaluation and price reads without qlib)
import qs_metrics as QM  # noqa: E402  (provider writers, rank-IC cross-check; no qlib)


class _Lazy:
    """qs_qlib imports qlib at module level; load it only when a full-research phase first needs it."""

    def __init__(self, name):
        self._name, self._mod = name, None

    def __getattr__(self, attr):
        if self._mod is None:
            import importlib
            try:
                self._mod = importlib.import_module(self._name)
            except ImportError as e:
                raise RuntimeError(QLIB_NEEDED + f" ({e})") from e
        return getattr(self._mod, attr)


QLIB_NEEDED = ("Full factor research (LightGBM / Qlib backtest) needs qlib, which this Python does not have. "
               "Idea tests and universe exports work without it. Install: engine/qlib_research/run.sh header.")
Q = _Lazy("qs_qlib")  # noqa: N816

PHASES = ["env", "universe", "data", "design", "features", "factors", "model",
          "robustness", "advanced", "portfolio", "overlay", "holdout", "report"]
# Idea test (--idea-file): the shared env/universe/data/design phases, then `idea`, then stop.
# Never runs model/holdout/report and never reads holdout-period returns.
IDEA_PHASES = ["env", "universe", "data", "design", "idea"]
ALL_PHASES = PHASES + ["idea"]
HORIZONS = [5, 10, 20, 40]
SHARED_QLIB = os.path.expanduser("~/.qlib/qlib_data/us_data")
CACHE = Path(os.path.expanduser("~/.qlib/qs_cache"))
ALIASES = {"semiconductors": "sox", "semis": "sox", "nasdaq100": "qqq", "nasdaq": "qqq",
           "ndx": "qqq", "dow": "dia", "djia": "dia", "spy": "sp500", "s&p500": "sp500", "spx": "sp500"}
BENCH_ALIAS = {"SOX": "SOXX", "NDX": "QQQ", "NASDAQ100": "QQQ", "DOW": "DIA", "DJIA": "DIA", "SP500": "SPY"}
ENGINE = "pit-v3"
VERSION = (Path(_HERE) / "VERSION").read_text().strip() if (Path(_HERE) / "VERSION").exists() else "dev"
# Pure ticker changes (same company) whose old symbol has no price history in either source.
# Applied only when the old symbol is priced for < 50% of its membership; checked against prices
# wherever both series exist; reported in data_audit.json and the report.
KNOWN_RENAMES = {
    "FB": ("META", "2022-06-09"), "PCLN": ("BKNG", "2018-02-27"), "KFT": ("MDLZ", "2012-10-02"),
    "RIMM": ("BB", "2013-08-12"), "SYMC": ("GEN", "2019-11-05"), "HANS": ("MNST", "2012-01-05"),
    "CTRP": ("TCOM", "2019-11-04"), "ERTS": ("EA", "2011-12-20"),
    "VIP": ("VEON", "2017-03-31"),  # VimpelCom; both sources' VIP are other securities (qs_data.IDENTITY_OVERRIDES)
}
FROZEN_KEYS = ["engine", "membership_file", "advanced", "target", "tickers", "benchmark", "start", "holdout_years", "min_train_years",
               "cost_bps", "seeds", "n_perm", "n_random", "null_signal", "data_source", "horizon", "features", "neutralize",
               "n_perm_tra", "idea_hash", "tune_trials"]
FROZEN_DEFAULTS = {"features": "alpha158", "neutralize": "none", "n_perm_tra": 20, "idea_hash": None, "tune_trials": 0}  # value assumed for runs made before the key existed
LGB_PARAMS = {"objective": "regression", "learning_rate": 0.02, "lambda_l1": 0.05, "lambda_l2": 0.05,
              "max_depth": 3, "num_leaves": 8, "colsample_bytree": 0.7, "subsample": 0.7,
              "subsample_freq": 1, "min_child_samples": 50, "verbosity": -1,
              "deterministic": True, "force_row_wise": True, "num_threads": 4}


def log(msg):
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Run state
# ---------------------------------------------------------------------------

class Run:
    def __init__(self, run_dir: Path, phases=None):
        self.dir = run_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.status_path = run_dir / "phase_status.json"
        self.status = json.loads(self.status_path.read_text()) if self.status_path.exists() else \
            {p: {"status": "pending"} for p in (phases or PHASES)}
        self.cfg = json.loads((run_dir / "config.json").read_text()) if (run_dir / "config.json").exists() else None

    def p(self, *parts) -> Path:
        return self.dir.joinpath(*parts)

    def save_status(self):
        C.atomic_write_json(self.status_path, self.status)

    def set(self, phase, status, **extra):
        self.status.setdefault(phase, {})
        self.status[phase].update({"status": status, "at": dt.datetime.now().isoformat(timespec="seconds"), **extra})
        self.save_status()

    def done(self, phase):
        return self.status.get(phase, {}).get("status") in ("complete", "skipped")

    def read(self, name):
        return json.loads(self.p(name).read_text())

    def write(self, name, obj):
        C.atomic_write_json(self.p(name), obj)

    def explog(self, entry):
        path = self.p("experiment_log.jsonl")
        entry = {"at": dt.datetime.now().isoformat(timespec="seconds"), **entry}
        with open(path, "a") as f:
            f.write(json.dumps(entry, default=C._json_default) + "\n")


# ---------------------------------------------------------------------------
# Phase 1: environment
# ---------------------------------------------------------------------------

def _ver(mod):
    try:
        m = __import__(mod)
        return getattr(m, "__version__", "installed")
    except Exception:  # noqa: BLE001
        return None


def provider_info(uri):
    cal = Path(uri) / "calendars" / "day.txt"
    if not cal.exists():
        return {"uri": uri, "exists": False}
    lines = cal.read_text().split()
    feats = Path(uri) / "features"
    return {"uri": uri, "exists": True, "calendar_start": lines[0], "calendar_end": lines[-1],
            "n_instruments": len(list(feats.iterdir())) if feats.exists() else 0,
            "stale_days": (pd.Timestamp.today().normalize() - pd.Timestamp(lines[-1])).days}


def phase_env(run, args):
    full = not ((run.cfg or {}).get("idea") or getattr(args, "idea_file", None) or args.stop_after in ("data", "design"))
    info = {"python": sys.executable, "python_version": platform.python_version(),
            "platform": platform.platform(),
            "packages": {m: _ver(m) for m in ["qlib", "lightgbm", "pandas", "numpy", "scipy",
                                              "matplotlib", "yfinance", "torch"]},
            "qlib_location": _qlib_location(),
            "shared_provider": provider_info(SHARED_QLIB),
            "cache_dir": str(CACHE)}
    need = ["qlib", "lightgbm", "pandas", "numpy", "matplotlib"] if full else ["pandas", "numpy", "matplotlib"]
    missing = [m for m in need if not info["packages"][m]]
    if missing:
        raise RuntimeError(f"Missing required packages in {sys.executable}: {missing}"
                           + (f". {QLIB_NEEDED}" if "qlib" in missing else ""))
    if info["qlib_location"] and "site-packages" not in info["qlib_location"] and "dist-packages" not in info["qlib_location"]:
        log(f"WARNING: qlib imported from {info['qlib_location']} (source checkout?)")
    run.write("env.json", info)
    sp = info["shared_provider"]
    shared = f"to {sp.get('calendar_end')} ({sp.get('stale_days')}d old)" if sp["exists"] else "missing"
    log(f"python {info['python_version']} at {sys.executable}; qlib {info['packages']['qlib'] or 'not installed (not needed)'}; "
        f"shared Qlib data {shared}")


def _qlib_location():
    import importlib.util
    spec = importlib.util.find_spec("qlib")
    return os.path.dirname(spec.origin) if spec and spec.origin else None


# ---------------------------------------------------------------------------
# Phase 2: universe
# ---------------------------------------------------------------------------

def phase_universe(run, args):
    cfg = run.cfg
    key = ALIASES.get(cfg["target"].lower(), cfg["target"].lower())
    mem = M.resolve(key, cfg["tickers"], cfg.get("membership_file"), SHARED_QLIB, cfg["start"],
                    pd.Timestamp.today().normalize(), log)
    iv = mem["intervals"]
    iv = iv[iv.end >= pd.Timestamp(cfg["start"])].sort_values(["ticker", "start"]).reset_index(drop=True)
    C.atomic_write_text(run.p("data", "membership.csv"), iv.to_csv(index=False, date_format="%Y-%m-%d"))
    tickers = sorted(iv.ticker.unique())
    bench = cfg["benchmark"]
    note = {
        "point-in-time": "Membership is point-in-time (day-exact). Names are eligible only while they were in "
                         "the index AND have price data; see the coverage table for members without prices.",
        "partial-point-in-time": f"Membership is point-in-time only up to {mem['as_of']}; afterwards that date's "
                                 "members are assumed unchanged. Survivorship bias is removed only up to then.",
        "snapshot": "SNAPSHOT membership: one list applied to all history. Survivorship bias and look-ahead in "
                    "membership are NOT removed; results are biased upward.",
    }[mem["kind"]]
    out = {"name": cfg["name"], "target": cfg["target"], "tickers": tickers, "n": len(tickers),
           "membership_kind": mem["kind"], "source": mem["source"], "as_of": mem["as_of"],
           "membership_notes": mem["notes"], "spells": int(len(iv)), "benchmark_etf": bench,
           "survivorship_note": note}
    run.write("universe.json", out)
    log(f"universe: {len(tickers)} names ever in {cfg['target']} since {cfg['start']} "
        f"({mem['kind']}; {mem['source']}); benchmark {bench}")
    if mem["kind"] == "snapshot":
        log("WARNING: snapshot membership — survivorship bias not removed (disclosed in report)")


# ---------------------------------------------------------------------------
# Phase 3: data (reuse shared Qlib data when fresh; otherwise build a per-target
# Qlib provider from cached Yahoo downloads, downloading only what is missing)
# ---------------------------------------------------------------------------

def _shared_has(t):
    return (Path(SHARED_QLIB) / "features" / t.lower() / "close.day.bin").exists()


def _last_bday():
    d = pd.Timestamp.today().normalize() - pd.Timedelta(days=1)
    while d.weekday() >= 5:
        d -= pd.Timedelta(days=1)
    return d


def _yahoo_frames(tickers, start):
    """Return {ticker: OHLCV DataFrame}. Reuse ~/.qlib/qs_cache/yahoo/<T>.csv when it was
    downloaded from <= start and reaches the last business day; download only the rest.
    Today's (possibly partial) bar is never requested.
    The cache doubles as an archive: when a refresh fails (typically a name delisted since it was cached, which
    Yahoo stops serving), the history already cached is used instead of dropping the name."""
    import yfinance as yf
    ydir = CACHE / "yahoo"
    ydir.mkdir(parents=True, exist_ok=True)
    ipath = ydir / "index.json"
    index = json.loads(ipath.read_text()) if ipath.exists() else {}
    need, out, stats = [], {}, {"reused": 0, "downloaded": 0, "failed": [], "archived": []}
    target_last = _last_bday() - pd.Timedelta(days=4)  # tolerate holidays
    for t in tickers:
        f, meta = ydir / f"{t}.csv", index.get(t)
        if f.exists() and meta and pd.Timestamp(meta["start"]) <= pd.Timestamp(start) \
                and (pd.Timestamp(meta["last"]) >= target_last or meta["downloaded"] == str(pd.Timestamp.today().date())):
            out[t] = pd.read_csv(f, index_col=0, parse_dates=True)
            stats["reused"] += 1
        else:
            need.append(t)
    today = str(pd.Timestamp.today().date())
    for i in range(0, len(need), 25):
        chunk = need[i:i + 25]
        data = yf.download(chunk, start=str(pd.Timestamp(start).date()), end=today, auto_adjust=True,
                           progress=False, group_by="ticker", threads=True, timeout=30)
        for t in chunk:
            try:
                df = data[t] if isinstance(data.columns, pd.MultiIndex) else data
                df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna(how="all")
                df.index = pd.DatetimeIndex(df.index).tz_localize(None)
                if len(df) < 50:
                    raise ValueError("too few rows")
                C.atomic_write_text(ydir / f"{t}.csv", df.to_csv())
                index[t] = {"start": str(pd.Timestamp(start).date()), "last": str(df.index[-1].date()), "downloaded": today}
                out[t] = df
                stats["downloaded"] += 1
            except Exception as e:  # noqa: BLE001
                old = ydir / f"{t}.csv"
                if old.exists() and index.get(t):
                    out[t] = pd.read_csv(old, index_col=0, parse_dates=True)
                    stats["archived"].append(t)
                else:
                    stats["failed"].append(f"{t}: {e}")
        C.atomic_write_json(ipath, index)
    return out, stats


def _prune_providers(name: str, keep: str, max_age_days: float = 14, keep_n: int = 3):
    """Drop old providers for the same --name (disk space). Keeps the newest keep_n and anything used in the last
    max_age_days, so a long run or a recent rescore never loses the provider recorded in its data_audit.json."""
    root = CACHE / "providers"
    cands = [p for p in root.glob(f"{name}*") if p.is_dir() and str(p) != keep and ".tmp-" not in p.name
             and (p.name == name or re.fullmatch(re.escape(name) + r"-[0-9a-f]{16}", p.name))]
    cands.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    cutoff = time.time() - max_age_days * 86400
    for p in cands[keep_n:]:
        if p.stat().st_mtime < cutoff:
            shutil.rmtree(p, ignore_errors=True)


def _write_provider(frames: dict, uri: Path, market: str):
    """Write Qlib's binary layout: calendars/day.txt, instruments/*.txt, features/<t>/<f>.day.bin."""
    cal = sorted(set().union(*[set(df.index) for df in frames.values()]))
    cal = pd.DatetimeIndex(cal)
    if uri.exists():
        shutil.rmtree(uri)
    (uri / "calendars").mkdir(parents=True)
    (uri / "instruments").mkdir()
    (uri / "calendars" / "day.txt").write_text("\n".join(d.strftime("%Y-%m-%d") for d in cal) + "\n")
    lines = []
    for t, df in frames.items():
        df = df[~df.index.duplicated()].sort_index()
        start_i = int(cal.searchsorted(df.index[0]))
        sub = df.reindex(cal[start_i: int(cal.searchsorted(df.index[-1])) + 1])
        fdir = uri / "features" / t.lower()
        fdir.mkdir(parents=True)
        for col in ["open", "high", "low", "close", "volume"]:
            np.hstack([[start_i], sub[col].values]).astype("<f4").tofile(fdir / f"{col}.day.bin")
        np.hstack([[start_i], np.ones(len(sub))]).astype("<f4").tofile(fdir / "factor.day.bin")
        vw = (sub[["high", "low", "close"]].mean(axis=1)).values  # typical-price proxy, flagged in report
        np.hstack([[start_i], vw]).astype("<f4").tofile(fdir / "vwap.day.bin")
        lines.append(f"{t.upper()}\t{df.index[0]:%Y-%m-%d}\t{df.index[-1]:%Y-%m-%d}")
    for name in ["all", market]:
        (uri / "instruments" / f"{name}.txt").write_text("\n".join(lines) + "\n")


def _source_label(p):
    if p["reason"] == "coverage override":
        return (f"shared-qlib (covers {p['shared_member_days']} member-days vs Yahoo {p['yahoo_member_days']}"
                + ("" if p.get("verified") else "; identity not price-verified") + ")")
    if p["reason"].startswith("Yahoo symbol reused"):
        return f"shared-qlib (Yahoo symbol rejected: return corr {p['corr']:.2f} over {p['n']}d)"
    if p["reason"].startswith("shared-qlib symbol belongs"):
        return (f"yahoo (shared-qlib symbol is an earlier security: return corr {p['corr']:.2f}; "
                f"Yahoo covers {p['yahoo_member_days']} member-days vs shared {p['shared_member_days']})")
    return p["source"]


def phase_data(run, args):
    cfg, uni = run.cfg, run.read("universe.json")
    iv = pd.read_csv(run.p("data", "membership.csv"), parse_dates=["start", "end"])
    bench = uni["benchmark_etf"]
    all_names = uni["tickers"] + ([bench] if bench and bench not in uni["tickers"] else [])
    shared = provider_info(SHARED_QLIB)
    src, notes = cfg["data_source"], []
    use_yahoo = src == "yahoo" or (src == "auto" and not (shared["exists"] and shared["stale_days"] <= args.max_stale_days))
    yf_frames = {}
    alias_targets = sorted({KNOWN_RENAMES[t][0] for t in uni["tickers"] if t in KNOWN_RENAMES} - set(all_names))
    if use_yahoo:
        try:
            yf_frames, st = _yahoo_frames(all_names + alias_targets, cfg["start"])
            notes.append(f"Yahoo cache: {st['reused']} reused, {st['downloaded']} downloaded, "
                         f"{len(st['archived'])} kept from the cache after a failed refresh (typically delisted since), "
                         f"{len(st['failed'])} unavailable (typically delisted/renamed)")
        except Exception as e:  # noqa: BLE001
            if src == "yahoo":
                raise
            notes.append(f"Yahoo download failed ({e}); using shared Qlib data only.")
    sh_frames, align_prov = {}, {}
    if shared["exists"]:
        # Date alignment of the shared store, measured per ticker against Yahoo (see qs_data.align_shared):
        # on this machine series re-dumped past Qlib's original 2020-11 end are dated one day early.
        orig_end = pd.Timestamp("2020-11-11")
        cache_f = CACHE / "shared_qlib_date_offset.json"
        cached = json.loads(cache_f.read_text()) if cache_f.exists() else {}
        start0 = pd.Timestamp(cfg["start"])
        def read(t, k):
            f = M.read_shared_bin(SHARED_QLIB, t, shift=k)
            return None if f is None else f.loc[start0:]
        sh_frames, align_prov, consensus, votes = Dq.align_shared(all_names, read, yf_frames, orig_end, cached)
        if any(votes.values()):
            C.atomic_write_json(cache_f, {**consensus, "votes": {g: len(v) for g, v in votes.items()},
                                          "measured": str(pd.Timestamp.today().date())})
        notes.append(f"Shared Qlib date alignment: series extended past {orig_end.date()} shifted "
                     f"{consensus['extended']:+d} day ({len(votes['extended'])} measured, "
                     f"{sum(v == consensus['extended'] for v in votes['extended'])} agree); original series shifted "
                     f"{consensus['original']:+d} ({len(votes['original'])} measured, "
                     f"{sum(v == consensus['original'] for v in votes['original'])} agree).")
    frames, source_prov = Dq.choose_sources(all_names + alias_targets, yf_frames, sh_frames, iv)
    rename_info = Dq.detect_renames(frames, iv, KNOWN_RENAMES)
    for x, r in rename_info.items():
        frames[x] = frames[r["to"]]
    source_of = {t: _source_label(p) for t, p in source_prov.items()}
    for x, r in rename_info.items():
        source_of[x] = (f"renamed to {r['to']} (" + (f"return corr {r['corr']:.3f} over {r['n']}d)" if r["basis"] == "price-verified"
                        else "curated symbol change, not price-verified)"))
    rejected = {t: p["corr"] for t, p in source_prov.items() if p["reason"].startswith("Yahoo symbol reused")}
    renames = {x: (r["to"], r["corr"], r["n"]) for x, r in rename_info.items()}
    if rename_info:
        notes.append("Ticker renames applied: " + ", ".join(f"{x}->{r['to']} ({r['basis']})" for x, r in rename_info.items()))
    if not frames:
        raise RuntimeError("No price data for any constituent.")
    # One calendar: days on which a reasonable share of priced names traded.
    cnt = pd.Series(1, index=pd.DatetimeIndex(np.concatenate([f.index.values for f in frames.values()]))).groupby(level=0).sum()
    cal = cnt[cnt >= np.maximum(3, 0.2 * cnt.rolling(250, min_periods=1).median())].index
    frames = {t: f.reindex(f.index.intersection(cal)) for t, f in frames.items()}
    sig = hashlib.sha256(json.dumps({t: [len(f), str(f.index[0].date()), str(f.index[-1].date()), source_of[t]]
                                     for t, f in sorted(frames.items())}).encode()).hexdigest()[:16]
    # Keyed by content signature, never rebuilt in place: another run with the same --name (e.g. every CUSTOM run,
    # or the same index with a different --start / newer data) may be mid-way through reading its own provider.
    # rmtree-ing it under that run silently shifts or empties its price reads.
    uri = str(CACHE / "providers" / f"{cfg['name']}-{sig}")
    sig_file = Path(uri) / "SOURCE_SIGNATURE"
    if sig_file.exists() and sig_file.read_text() == sig:
        os.utime(uri)  # mark as in use so _prune_providers keeps it
        notes.append(f"Reused existing Qlib provider {uri}")
    else:
        tmp_uri = Path(f"{uri}.tmp-{os.getpid()}")
        _write_provider(frames, tmp_uri, cfg["name"].lower())
        (tmp_uri / "SOURCE_SIGNATURE").write_text(sig)
        try:
            os.replace(tmp_uri, uri)
        except OSError:  # a concurrent run built the identical provider first
            shutil.rmtree(tmp_uri, ignore_errors=True)
        notes.append(f"Built Qlib provider {uri}")
        _prune_providers(cfg["name"], keep=uri)
    names = sorted(t for t in frames if t in all_names)
    # read back exactly what qlib's D.features would return (checked equal on a 601-name S&P 500 run)
    px = X.fields_wide(X.BinData(uri), names, ["open", "close", "volume"], start=cfg["start"])
    opens, closes, vol = px["open"], px["close"], px["volume"]
    uni_cols = [t for t in uni["tickers"] if t in closes]
    member = M.member_matrix(iv, closes.index, uni["tickers"])
    priced = closes.reindex(columns=uni["tickers"]).notna() & opens.reindex(columns=uni["tickers"]).notna()
    n_mem, n_ok = member.sum(axis=1), (member & priced).sum(axis=1)
    ok_days = n_ok[(n_mem > 0) & (n_ok >= 0.8 * n_mem)].index
    eff_end = ok_days.max() if len(ok_days) else closes.index.max()
    opens, closes, vol, member, priced = (x.loc[:eff_end] for x in (opens, closes, vol, member, priced))
    eligible, unpriced, partial, overall = Dq.member_price_coverage(member, priced, iv)
    cov = M.coverage_by_year(member, priced)
    if overall < 0.5:
        raise RuntimeError(f"Only {overall:.0%} of member-days have prices; results would be unreliable.")
    audit = {}
    for t in names:
        c = closes[t].dropna() if t in closes else pd.Series(dtype=float)
        if not len(c):
            continue
        r = c.pct_change().abs()
        audit[t] = {"source": source_of.get(t), "first": str(c.index.min().date()), "last": str(c.index.max().date()),
                    "jumps_gt_40pct": [str(d.date()) for d in r[r > 0.4].index][:10]}
    C.atomic_pickle(run.p("data", "prices.pkl"), {"open": opens, "close": closes})
    C.atomic_pickle(run.p("data", "eligible.pkl"), eligible)
    present = [t for t in uni["tickers"] if eligible[t].any()] if len(eligible.columns) else []
    out = {"provider_uri": uri, "decision": "yahoo+shared-qlib" if yf_frames else "shared-qlib",
           "shared_qlib_alignment": align_prov, "source_provenance": source_prov, "renames_detail": rename_info,
           "uncertain_corrections": Dq.uncertain_corrections(align_prov, source_prov, rename_info, present),
           "notes": notes, "tickers_with_data": present,
           "missing": sorted(set(uni["tickers"]) - set(present)),
           "benchmark_available": bool(bench) and bench in closes and closes[bench].dropna().index.max() >= eff_end - pd.Timedelta(days=14),
           "calendar_start": str(closes.index.min().date()), "calendar_end": str(closes.index.max().date()),
           "member_day_coverage": overall, "coverage_by_year": cov.rename_axis("year").reset_index().to_dict("records"),
           "members_never_priced": unpriced, "members_partly_priced": partial,
           "yahoo_symbols_rejected": rejected, "renames": {x: y for x, (y, _, _) in renames.items()},
           "per_ticker": audit,
           "price_note": "Adjusted prices (Yahoo for listed names; Qlib's shared US data for names Yahoo no longer "
                         "serves). Fills use the adjusted open. A name whose prices stop while held is sold at its "
                         "last close (true delisting returns are unknown)."}
    if _uses_fund(cfg) or _neutral(cfg) or _idea_fund(cfg):
        out["fundamentals"] = _sec_data(run, closes, eligible, present, rename_info)
    if _uses_fund(cfg):  # fundamentals become Qlib fields ($f_ep, $f_roa, ...) of the run's provider
        fp = pd.read_pickle(run.p("data", "fundamentals.pkl"))
        QM.write_fields(uri, {f.lower(): v for f, v in fp.items()})
    if _idea_mkt(cfg):  # $mkt: the universe's own equal-weight market return, the same series on every name
        mkt = IDEA.market_return(closes, eligible)
        QM.write_fields(uri, {IDEA.MARKET_FIELD: pd.DataFrame({t: mkt for t in names}, index=mkt.index)})
        out["market_field"] = {"field": "$" + IDEA.MARKET_FIELD, "days": int(mkt.notna().sum()),
                               "first": str(mkt.first_valid_index().date()) if mkt.notna().any() else None,
                               "min_names": IDEA.MARKET_MIN_NAMES,
                               "definition": "equal-weight mean of close_t/close_{t-1}-1 over that day's index members "
                                             "with prices on t and t-1 (point-in-time; only t and t-1 data)"}
        log(f"data: built $mkt (equal-weight market return of the universe) on {out['market_field']['days']} days")
    # Point-in-time universe as a Qlib market: one instruments line per eligible spell
    el_now = pd.read_pickle(run.p("data", "eligible.pkl"))
    QM.write_instruments(uri, _pit_market(run), QM.spells_from_mask(el_now.reindex(columns=present).fillna(False)))
    out["qlib_market"] = _pit_market(run)
    run.write("data_audit.json", out)
    for n in notes:
        log(n)
    log(f"data: {len(present)}/{len(uni['tickers'])} members priced; member-day coverage {overall:.1%}; "
        f"{out['calendar_start']} .. {out['calendar_end']}")


def _uses_fund(cfg):
    return cfg.get("features", "alpha158") != "alpha158"


def _neutral(cfg):
    return cfg.get("neutralize", "none") == "sector"


def _idea_fund(cfg):
    """Idea test with a fundamental component: the SEC panel is built, eligibility is NOT reduced
    (price-only factors of the same idea keep the full point-in-time universe)."""
    return IDEA.uses_fundamentals(cfg.get("idea"))


def _idea_mkt(cfg):
    """Idea test whose formula reads $mkt: the market-return field is built into the run's provider."""
    return IDEA.uses_market(cfg.get("idea"))


def _sec_data(run, closes, eligible, present, rename_info):
    """SEC EDGAR: ticker -> CIK, SIC sectors, and (if requested) point-in-time fundamental panels."""
    import qs_fundamentals as F
    sec = F.Sec()
    el = eligible[present]
    spans = {t: (el.index[el[t]].min(), el.index[el[t]].max()) for t in present}
    cmap = F.resolve_ciks(sec, spans, {x: r["to"] for x, r in rename_info.items()}, log=log)
    sectors, sic = {}, {}
    for t, m in cmap.items():
        s = (sec.submissions(m["cik"]) or {}) if m["cik"] else {}
        sic[t] = s.get("sic") or None
        sectors[t] = F.sector_of_sic(sic[t])
    C.atomic_write_json(run.p("data", "sectors.json"), sectors)
    out = {"source": "SEC EDGAR XBRL company facts (data.sec.gov) and submissions (SIC codes)",
           "mapping": cmap, "sic": sic,
           "mapping_counts": dict(Counter(F.mapping_kind(m) for m in cmap.values())),
           "unresolved": sorted(t for t, m in cmap.items() if not m["cik"]),
           "uncertain_mappings": sorted(t for t, m in cmap.items() if m["uncertain"]),
           "sector_counts": dict(Counter(sectors.values())),
           "rules": ["value usable from the first trading day after its filing date; earliest filing of each period only",
                     "flows as trailing twelve months (annual facts, else four discrete quarters, Q4 and cash-flow "
                     "quarters derived from year-to-date values)",
                     "market value = cover-page public float rolled forward with the adjusted close (split-proof; "
                     "excludes insider holdings; includes dividends)",
                     "sectors = current SEC SIC code grouped into 11 GICS-like sectors"]}
    if _uses_fund(run.cfg) or _idea_fund(run.cfg):
        dates = closes.index
        cols = {f: {} for f in F.FEATURES}
        done = 0
        for t, m in cmap.items():
            if not m["cik"]:
                continue
            p = F.company_panel(F.facts_for(sec, m), dates, closes[t])
            for f in F.FEATURES:
                cols[f][t] = p[f].values
            done += 1
            if done % 100 == 0:
                log(f"  fundamentals built for {done} companies")
        panel = {f: pd.DataFrame(v, index=dates).reindex(columns=present).astype("float32") for f, v in cols.items()}
        C.atomic_pickle(run.p("data", "fundamentals.pkl"), panel)
        has = _fund_available(panel)
        elig = el.reindex(dates, fill_value=False)
        yr = dates.year
        cov = ((has & elig).sum(axis=1).groupby(yr).sum() / elig.sum(axis=1).groupby(yr).sum().replace(0, np.nan))
        out["coverage_by_year"] = {int(y): round(float(v), 3) for y, v in cov.dropna().items()}
        out["feature_coverage"] = {f: round(float((panel[f].notna() & elig).values.sum() / max(elig.values.sum(), 1)), 3)
                                   for f in F.FEATURES}
        out["features"] = F.FEATURES
    if _uses_fund(run.cfg):
        # Same reduced universe for the strategy and every baseline: a name-day without core
        # fundamentals is not eligible (zero-filled features would let missingness, which is more
        # common for names that later left the index, act as a signal).
        new_el = eligible & has.reindex(index=eligible.index, columns=eligible.columns).fillna(False).astype(bool)
        out["eligibility"] = "index member AND priced AND core fundamentals (profitability or valuation) known"
        out["member_days_dropped_no_fundamentals"] = round(float(1 - new_el.values.sum() / max(eligible.values.sum(), 1)), 4)
        C.atomic_pickle(run.p("data", "eligible.pkl"), new_el)
    out["requests"] = sec.n
    log(f"SEC: {sum(1 for m in cmap.values() if m['cik'])}/{len(cmap)} priced members mapped to a filer "
        f"({out['mapping_counts']}); sectors {out['sector_counts']}")
    if "coverage_by_year" in out:
        log(f"SEC fundamentals coverage of eligible member-days by year: {out['coverage_by_year']}")
    return out


def _fund_available(panel):
    """Name-days with the core fundamentals (profitability or valuation) known."""
    return panel["F_ROA"].notna() | panel["F_EP"].notna()


def _sectors(run):
    if getattr(run, "_sec_cache", None) is None:
        run._sec_cache = json.loads(run.p("data", "sectors.json").read_text())
    return run._sec_cache


def _targets(run, scores, sig, k, n_drop=None, exposure=None):
    if _neutral(run.cfg):
        return C.build_targets_balanced(scores, _sectors(run), sig, k, exposure)
    return C.build_targets(scores, sig, k, n_drop, exposure)


def _long_short(run, opens, closes, scores, sig, k, cost, start, end):
    """Diagnostic: daily return of the top-K portfolio minus the bottom-K portfolio (same construction,
    costs on both legs, no borrow cost)."""
    top = _sim(run, _targets(run, scores, sig, k), cost, start, end)["nav"]
    bot = _sim(run, _targets(run, -scores, sig, k), cost, start, end)["nav"]
    r = (top.pct_change() - bot.pct_change()).fillna(0.0)
    nav = (1 + r).cumprod()
    p = Q.perf(nav)
    return {"cagr": p.get("cagr"), "sharpe": p.get("sharpe"), "max_drawdown": p.get("max_drawdown"),
            "t_stat": float(r.mean() / r.std() * np.sqrt(len(r))) if r.std() > 0 else float("nan")}


# ---------------------------------------------------------------------------
# Qlib session and backtests
# ---------------------------------------------------------------------------

_RUN_URI = [None]
_QINIT = {"uri": None}


def _qinit_uri(uri, qlib=False):
    """Point formula evaluation (qs_idea / qs_expr) at the run's data; with qlib=True also qlib.init it
    for the full-research phases."""
    if not uri:
        return
    IDEA.set_provider(uri)
    if qlib and _QINIT["uri"] != uri:
        try:
            import qlib as _qlib
            from qlib.constant import REG_US
        except ImportError as e:
            raise RuntimeError(QLIB_NEEDED + f" ({e})") from e
        _qlib.init(provider_uri=uri, region=REG_US, kernels=1)
        _QINIT["uri"] = uri


def _qinit(run, qlib=False):
    if run.p("data_audit.json").exists():
        _RUN_URI[0] = run.read("data_audit.json")["provider_uri"]
        _qinit_uri(_RUN_URI[0], qlib=qlib)


def _pit_market(run):
    return re.sub(r"[^a-z0-9_]", "_", run.dir.name.lower()) + "_eligible"


def _sim(run, targets, cost, start, end):
    """Every backtest runs in Qlib's engine (qlib.backtest; see qs_qlib.py)."""
    _qinit(run, qlib=True)
    if getattr(run, "_bt_ctx", None) is None:
        closes = pd.read_pickle(run.p("data", "prices.pkl"))["close"]
        bench = run.read("universe.json")["benchmark_etf"]
        codes = list(_universe_cols(run)) + ([bench] if bench and bench in closes and bench not in _universe_cols(run) else [])
        de = closes.apply(lambda s_: s_.last_valid_index()).dropna()
        run._bt_ctx = (codes, bench if bench in codes else codes[0], {t: pd.Timestamp(d) for t, d in de.items()})
    codes, bench, de = run._bt_ctx
    return Q.run_backtest(targets, start, end, cost, codes, bench, data_end=de)



# ---------------------------------------------------------------------------
# Phase 4: experiment design (frozen before any research)
# ---------------------------------------------------------------------------

def phase_design(run, args):
    cfg, da = run.cfg, run.read("data_audit.json")
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    closes = px["close"][da["tickers_with_data"]]
    elig = pd.read_pickle(run.p("data", "eligible.pkl"))
    if _uses_fund(cfg):  # research starts once fundamentals exist (XBRL filing began 2009-2011)
        has = _fund_available(pd.read_pickle(run.p("data", "fundamentals.pkl")))
        elig = elig & has.reindex(index=elig.index, columns=elig.columns).fillna(False).astype(bool)
    breadth = elig.sum(axis=1)
    first = breadth[breadth >= max(10, int(0.5 * breadth.max()))].index.min()
    feat_start = closes.index[min(closes.index.searchsorted(first) + 60, len(closes.index) - 1)]  # 60d warm-up
    cal = closes.index
    s = C.design_splits(cal, feat_start, cfg["holdout_years"], max(HORIZONS), cfg["min_train_years"])
    problems = C.check_no_overlap(s, cal)
    if problems:
        raise RuntimeError(f"split overlap: {problems}")
    j = C.splits_to_json(s)
    j["feature_start"] = str(feat_start.date())
    j["purge_note"] = (f"Every train/valid segment ends {s['purge_days']} trading days before the next "
                       f"segment (= longest candidate horizon {max(HORIZONS)} + 1), so no label used for "
                       "fitting or early stopping overlaps a later evaluation period.")
    run.write("splits.json", j)
    cfg["splits_frozen_at"] = dt.datetime.now().isoformat(timespec="seconds")
    # options left at their default are omitted, so hashes of runs made before they existed are unchanged
    frozen = {k: cfg.get(k, FROZEN_DEFAULTS.get(k)) for k in FROZEN_KEYS}
    frozen = {k: v for k, v in frozen.items() if not (k in FROZEN_DEFAULTS and v == FROZEN_DEFAULTS[k])}
    cfg["config_hash"] = hashlib.sha256(json.dumps(frozen, sort_keys=True).encode()).hexdigest()[:12]
    C.atomic_write_json(run.p("config.json"), cfg)
    run.cfg = cfg
    log(f"design: {len(s['folds'])} walk-forward test years {s['folds'][0].name}..{s['folds'][-1].name}; "
        f"holdout {j['holdout_start']}..{j['end']} (locked)")


# ---------------------------------------------------------------------------
# Phase 5: Qlib Alpha158 features + labels
# ---------------------------------------------------------------------------

def phase_features(run, args):
    cfg, da, sp = run.cfg, run.read("data_audit.json"), run.read("splits.json")
    _qinit(run, qlib=True)
    labels = ([C.label_expr(h) for h in HORIZONS], [f"LABEL{h}" for h in HORIZONS])
    mode = cfg.get("features", "alpha158")
    cut = sp["folds"][len(sp["folds"]) // 2]["test"][0]
    audit, dropped, parts = {}, [], []
    # Point-in-time Qlib market (members AND priced [AND fundamentals]) for the fundamental modes;
    # the Alpha158-only mode keeps the v1.0 instrument list (same ranking universe as earlier runs).
    insts = da.get("qlib_market") if mode != "alpha158" else da["tickers_with_data"]
    kinds = {"alpha158": ["alpha158"], "fundamental": ["fundamental"], "both": ["alpha158", "fundamental"]}[mode]
    for i, kind in enumerate(kinds):
        f_, l_, audit[kind] = _qlib_features(kind, insts, sp, cut, labels if i == 0 else None)
        parts.append(f_)
        if i == 0:
            lab = l_
    feat = pd.concat(parts, axis=1) if len(parts) > 1 else parts[0]
    nan_frac = feat.isna().mean()
    dropped = sorted(nan_frac[nan_frac > 0.5].index.tolist())
    feat = feat.drop(columns=dropped).fillna(0.0).astype("float32")
    if mode != "alpha158":
        audit["fundamental_sec"] = _fund_audit(run, cut)
    if cfg["null_signal"]:
        # Synthetic weak-signal control: shuffle feature rows across names within each date.
        rng = np.random.default_rng(12345)
        vals = feat.values.copy()
        codes = feat.index.get_level_values(0)
        for d0, idx in pd.Series(np.arange(len(feat)), index=codes).groupby(level=0):
            vals[idx.values] = vals[rng.permutation(idx.values)]
        feat = pd.DataFrame(vals, index=feat.index, columns=feat.columns)
    el = pd.read_pickle(run.p("data", "eligible.pkl")).stack()
    el.index.names = ["datetime", "instrument"]
    elig = el.reindex(lab.index, fill_value=False).astype(bool)
    lab.loc[~elig.values, :] = np.nan  # labels only where the name was a priced index member
    if mode == "alpha158":
        # Qlib served the whole priced history of every name ever in the index, so its CSRankNorm ranked each day
        # among names that only join LATER (future-membership knowledge) and names already removed. Re-rank each
        # day among that day's eligible members only, on the same (pct - 0.5) x 3.46 scale.
        feat = C.rerank_among_eligible(feat, elig)
    if _neutral(cfg):
        # The model is trained and judged on returns relative to the stock's own sector that day.
        lcols = [f"LABEL{hh}" for hh in HORIZONS]
        for hh in HORIZONS:
            lab[f"RAW{hh}"] = lab[f"LABEL{hh}"]
        lab[lcols] = Q.SectorDemean(_sectors(run))(lab[lcols])  # Qlib Processor
    lab["ELIGIBLE"] = elig.astype("float32").values
    C.atomic_pickle(run.p("data", "features.pkl"), feat)
    C.atomic_pickle(run.p("data", "labels.pkl"), lab.astype("float32"))
    n_f = sum(c.startswith("F_") for c in feat.columns)
    run.write("features.json", {"mode": mode, "qlib_market": insts if isinstance(insts, str) else None,
                                "handler": {"alpha158": "qlib.contrib.data.handler.Alpha158",
                                            "fundamental": "SEC XBRL point-in-time factors (qs_fundamentals.py); labels via Qlib D.features",
                                            "both": "Alpha158 + SEC XBRL point-in-time factors"}[mode],
                                "processors": "per date: rank among eligible names -> (pct - 0.5) x 3.46 (CSRankNorm scale); NaN -> 0 (cross-sectional median)",
                                "alpha158_reranked_among_eligible": mode == "alpha158",  # runs before this fix ranked among all priced names
                                "n_features": int(feat.shape[1]), "n_fundamental": int(n_f), "rows": int(len(feat)),
                                "dropped_mostly_nan": dropped, "labels": dict(zip(labels[1], labels[0])),
                                "label_neutralization": "sector-demeaned (SIC sectors)" if _neutral(cfg) else "none",
                                "null_signal": cfg["null_signal"], "eligible_rows": int(elig.sum()),
                                "lookahead_audit": audit})
    log(f"features: {feat.shape[1] - n_f} Alpha158 + {n_f} fundamental columns x {len(feat)} rows "
        f"(dropped {len(dropped)} mostly-NaN){'; labels sector-demeaned' if _neutral(cfg) else ''}")


def _qlib_features(kind, insts, sp, cut, labels=None):
    """Features (and labels) from a Qlib DataHandlerLP: Alpha158, or the $f_* fundamental fields
    through QlibDataLoader. Processors: ProcessInf -> CSRankNorm(feature) per date. Look-ahead audit:
    the handler is rebuilt with data ending at a past date; rows on that date must not change."""
    from qlib.contrib.data.handler import Alpha158
    from qlib.data.dataset.handler import DataHandlerLP
    import qs_fundamentals as F
    procs = [{"class": "ProcessInf", "kwargs": {}}, {"class": "CSRankNorm", "kwargs": {"fields_group": "feature"}}]

    def build(end):
        if kind == "alpha158":
            kw = {"label": labels} if labels else {}
            return Alpha158(instruments=insts, start_time=sp["feature_start"], end_time=end,
                            fit_start_time=sp["folds"][0]["train"][0], fit_end_time=sp["folds"][0]["train"][1],
                            infer_processors=procs, learn_processors=[], **kw)
        conf = {"feature": ([f"${f.lower()}" for f in F.FEATURES], list(F.FEATURES))}
        if labels:
            conf["label"] = labels
        return DataHandlerLP(instruments=insts, start_time=sp["feature_start"], end_time=end,
                             data_loader={"class": "QlibDataLoader", "kwargs": {"config": conf}},
                             infer_processors=procs, learn_processors=[])

    def fetch(h, col):
        x = h.fetch(col_set=col, data_key=DataHandlerLP.DK_I if col == "feature" else DataHandlerLP.DK_R)
        if x.index.names[0] != "datetime":
            x = x.swaplevel().sort_index()
        x.index.names = ["datetime", "instrument"]
        return x

    h = build(sp["end"])
    feat = fetch(h, "feature")
    lab = fetch(h, "label") if labels else None
    fc = fetch(build(cut), "feature")
    d_cut = fc.index.get_level_values(0).max()
    a_, b_ = fc.xs(d_cut, level=0), feat.xs(d_cut, level=0).reindex(index=fc.xs(d_cut, level=0).index)
    diff = float(np.nanmax(np.abs(a_.values - b_[a_.columns].values))) if a_.size else 0.0
    if not diff < 1e-4:
        raise RuntimeError(f"Look-ahead audit failed ({kind}): features at {d_cut.date()} change when later data is "
                           f"added (max abs diff {diff:.3g}).")
    return feat, lab, {"cut_date": str(d_cut.date()), "max_abs_diff": diff,
                       "handler": "qlib.contrib.data.handler.Alpha158" if kind == "alpha158" else
                                  "qlib DataHandlerLP + QlibDataLoader($f_* fields)"}


def _fund_audit(run, cut):
    """SEC look-ahead audit: every mapped company is rebuilt from the filings available at two past
    dates (first test year, middle fold) and prices up to them; its raw values on those dates must
    equal the full-history values."""
    import qs_fundamentals as F
    panel = pd.read_pickle(run.p("data", "fundamentals.pkl"))
    fa = run.read("data_audit.json")["fundamentals"]
    mapped = sorted(t for t, m in fa["mapping"].items() if m["cik"])
    closes = pd.read_pickle(run.p("data", "prices.pkl"))["close"]
    sp = run.read("splits.json")
    cuts = sorted({closes.index[closes.index <= pd.Timestamp(c)][-1] for c in (sp["folds"][0]["test"][0], cut)})
    jobs = [(t, fa["mapping"][t], closes[t], pd.DataFrame({f: panel[f][t] for f in F.FEATURES}), cuts) for t in mapped]
    from multiprocessing import get_context
    with get_context("spawn").Pool(max(1, min(8, (os.cpu_count() or 2) - 1))) as pool:
        res = pool.map(F.audit_company, jobs, chunksize=4)
    bad = {t: b for t, b in res if b}
    if bad:
        t0 = sorted(bad)[0]
        raise RuntimeError(f"Fundamental look-ahead audit failed for {len(bad)} companies, e.g. {t0}: {bad[t0][:2]}")
    return {"cut_dates": [str(c.date()) for c in cuts], "companies": len(mapped), "mismatches": 0,
            "note": "every mapped company rebuilt from filings available at each cut date and prices up to it; "
                    "values on the cut dates equal the full-history values"}


def _raw_label(run, Y, h, dev):
    """Raw h-day forward return (before any sector demeaning), optionally cut like dev_label."""
    col = f"RAW{h}" if f"RAW{h}" in Y else f"LABEL{h}"
    lab = Y[col]
    if not dev:
        return lab
    sp = run.read("splits.json")
    cal = pd.read_pickle(run.p("data", "prices.pkl"))["close"].index
    cut = cal[max(int(cal.searchsorted(pd.Timestamp(sp["holdout_start"]))) - (h + 2), 0)]
    return lab.where(lab.index.get_level_values(0) <= cut)


def dev_label(run, Y, h):
    """h-day label restricted to values fully realised before the holdout starts, so
    development statistics never read holdout prices."""
    sp = run.read("splits.json")
    cal = pd.read_pickle(run.p("data", "prices.pkl"))["close"].index
    cut = cal[max(int(cal.searchsorted(pd.Timestamp(sp["holdout_start"]))) - (h + 2), 0)]
    lab = Y[f"LABEL{h}"]
    return lab.where(lab.index.get_level_values(0) <= cut)


def load_xy(run):
    return pd.read_pickle(run.p("data", "features.pkl")), pd.read_pickle(run.p("data", "labels.pkl"))


def _between(idx, a, b):
    d = idx.get_level_values(0)
    return (d >= pd.Timestamp(a)) & (d <= pd.Timestamp(b))


def factor_ic_table(X: pd.DataFrame, y: pd.Series, h: int) -> pd.DataFrame:
    """Per-feature daily rank IC from Qlib's calc_all_ic, summarised (mean, ICIR, non-overlapping t)."""
    ok = y.notna()
    ic = Q.factor_rank_ic(X[ok], y[ok])
    no = ic.iloc[::h]
    return pd.DataFrame({"mean_ic": ic.mean(), "icir": ic.mean() / ic.std(),
                         "t_nonoverlap": no.mean() / (no.std() / np.sqrt(no.count())),
                         "n_days": ic.count()})


# ---------------------------------------------------------------------------
# Phase 6: horizon + factor research (first fold's training window ONLY)
# ---------------------------------------------------------------------------

def phase_factors(run, args):
    sp = run.read("splits.json")
    X, Y = load_xy(run)
    a, b = sp["folds"][0]["train"]
    m = _between(X.index, a, b)
    tables, counts = [], {}
    for h in HORIZONS:
        t = factor_ic_table(X[m], Y.loc[m, f"LABEL{h}"], h)
        t["horizon"] = h
        tables.append(t)
        counts[h] = {"icir_gt_0.10": int((t.icir.abs() > 0.10).sum()), "icir_gt_0.05": int((t.icir.abs() > 0.05).sum()),
                     "abs_t_gt_2": int((t.t_nonoverlap.abs() > 2).sum())}
    tab = pd.concat(tables)
    tab.index.name = "factor"
    C.atomic_write_text(run.p("results", "factor_analysis.csv"), tab.to_csv())
    forced = run.cfg.get("horizon")
    if forced and forced in HORIZONS:
        best = forced
        rule = f"horizon = {forced}d (user override via --horizon)"
    else:
        best = max(HORIZONS, key=lambda h: (counts[h]["abs_t_gt_2"], counts[h]["icir_gt_0.10"], -h))
        rule = ("horizon = most factors with |t|>2 on NON-overlapping dates (ICIR on overlapping "
                "labels is mechanically inflated for long horizons), first fold's training window only; "
                "ties -> more |ICIR|>0.10 -> shorter horizon")
    weak = counts[best]["icir_gt_0.05"] == 0
    top = tab[tab.horizon == best].assign(a=lambda d: d.icir.abs()).sort_values("a", ascending=False).head(15)
    fam = top.index.str.extract(r"^(F_[A-Z]+|[A-Z]+)")[0].value_counts().to_dict()
    out = {"window": [a, b], "counts_by_horizon": counts, "horizon": best, "weak_factor_signal": weak,
           "top_factors": top[["mean_ic", "icir", "t_nonoverlap"]].round(4).reset_index().to_dict("records"),
           "top15_families": fam, "rule": rule}
    run.write("factors.json", out)
    log(f"factors: horizon {best}d chosen; counts {counts}" + ("  [WEAK: no factor |ICIR|>0.05]" if weak else ""))


# ---------------------------------------------------------------------------
# Phase 7: walk-forward LightGBM (per-fold feature selection on that fold's train data)
# ---------------------------------------------------------------------------

def _rank_label(y):
    return y.groupby(level=0).rank(pct=True) - 0.5


def select_features(X, y, h, lo=15, hi=60):
    t = factor_ic_table(X, y, h)
    t = t.assign(a=t.icir.abs()).sort_values("a", ascending=False)
    n = int(np.clip((t.a > 0.05).sum(), lo, hi))
    return list(t.index[:n])


_SEL_CACHE = {}  # per-fold feature screen (uses unshuffled training labels, so permutations reuse it)


def fit_predict(X, Y, fold, h, seeds, shuffle_seed=None, params=None, predict="test"):
    """predict="valid" scores the fold's purged validation year instead of its test year (used only by
    hyperparameter tuning, so that tuning never looks at a test year or the holdout)."""
    _qinit_uri(_RUN_URI[0], qlib=True)
    lab = Y[f"LABEL{h}"]
    tr = _between(X.index, *fold["train"]) & lab.notna().values
    va = _between(X.index, *fold["valid"]) & lab.notna().values
    seg = fold["valid"] if predict == "valid" else fold["test"]
    te = _between(X.index, *seg) & (Y["ELIGIBLE"].values > 0)
    key = (fold["name"], h, X.shape[1])
    if key not in _SEL_CACHE:
        _SEL_CACHE[key] = select_features(X[tr], lab[tr], h)
    cols = _SEL_CACHE[key]
    # Qlib LGBModel on a Qlib DatasetH (labels: DropnaLabel -> [within-date shuffle for the
    # permutation control, training window only] -> CSRankNorm); test rows are the eligible ones.
    rows = tr | va | te
    y = lab.where(pd.Series(tr | va, index=lab.index))[rows]
    segs = {"train": tuple(fold["train"]), "valid": tuple(fold["valid"]), "test": tuple(seg)}
    P, iters = Q.lgb_fit_predict(X.loc[rows, cols], y, segs, params or LGB_PARAMS, seeds, shuffle_seed)
    P = P.reindex(X.index[te]).groupby(level=0).rank(pct=True)
    return P, cols, iters


def ridge_fold_predict(X, Y, fold, h, cols):
    """Ridge baseline on exactly the rows and features LightGBM used in this fold (qs_core.ridge_fold)."""
    lab = Y[f"LABEL{h}"]
    tr = _between(X.index, *fold["train"])
    va = _between(X.index, *fold["valid"])
    te = _between(X.index, *fold["test"]) & (Y["ELIGIBLE"].values > 0)
    rows = tr | va | te
    Xr = C.cs_rank_features(X.loc[rows, cols])
    r = C.ridge_fold(Xr, lab[rows], tr[rows], va[rows], te[rows])
    r["pred"] = r["pred"].groupby(level=0).rank(pct=True)
    return r


def _ridge_baseline(run, X, Y, sp, h, folds_done, lab, lgb_pred):
    """Fit the ridge baseline per fold (cached like the LightGBM folds) and compare it with LightGBM."""
    per_fold, parts = {}, []
    for fold in sp["folds"]:
        part = run.p("results", "ridge_folds", f"{fold['name']}.pkl")
        meta = run.p("results", "ridge_folds", f"{fold['name']}.json")
        if part.exists() and meta.exists():
            pred, info = pd.read_pickle(part), json.loads(meta.read_text())
        else:
            r = ridge_fold_predict(X, Y, fold, h, folds_done[fold["name"]]["features"])
            pred = r["pred"]
            info = {"alpha": r["alpha"], "valid_ic": r["valid_ic"], "weights": r["weights"]}
            C.atomic_pickle(part, pred)
            C.atomic_write_json(meta, info)
        info["test_ic"] = C.ic_summary(Q.qlib_ic(pred, lab), h)
        per_fold[fold["name"]] = {k: info[k] for k in ("alpha", "valid_ic", "test_ic")}
        parts.append(pred)
    rp = pd.concat(parts).sort_index()
    ic_r, ic_l = Q.qlib_ic(rp, lab), Q.qlib_ic(lgb_pred, lab)
    diff = C.ic_difference(ic_l, ic_r, h)
    beats = bool(np.isfinite(diff["t_nonoverlap"]) and diff["t_nonoverlap"] >= 2.0 and diff["mean_ic"] > 0)
    out = {"model": "ridge regression (L2) on per-date ranked features; penalty chosen on each fold's purged validation year",
           "alphas": list(C.RIDGE_ALPHAS), "walk_forward_ic": C.ic_summary(ic_r, h), "folds": per_fold,
           "lgb_minus_ridge": diff, "lgb_beats_ridge": beats,
           "reading": ("LightGBM's daily rank IC is higher than the linear baseline's by a margin unlikely to be luck (t >= 2)."
                       if beats else "LightGBM does not measurably beat a linear ridge model on the same features: "
                       "its extra flexibility is not supported by this data, and the simpler model would do as well.")}
    log(f"ridge baseline: walk-forward IC {out['walk_forward_ic']['mean_ic']:+.4f}; LightGBM minus ridge "
        f"{diff['mean_ic']:+.4f} (t {diff['t_nonoverlap']:.2f}) -> {'LightGBM better' if beats else 'no measurable gain'}")
    return out


def _lgb_params(run):
    """LightGBM parameters for this run: the fixed LGB_PARAMS, or the tuned config if tuning chose one."""
    f = run.p("results", "tuning.json")
    if f.exists():
        t = json.loads(f.read_text())
        if t.get("status") == "done" and t.get("chosen_params"):
            return {**LGB_PARAMS, **t["chosen_params"]}
    return LGB_PARAMS


def _tune_lgb(run, X, Y, sp, h, n):
    """Opt-in hyperparameter tuning (cfg tune_trials = n > 0). Latin-hypercube configs scored by mean
    validation-year rank IC with successive halving: all configs on 3 folds spread over time, the best
    third (plus the defaults) on every fold. One seed per fit. Test years and the holdout are never read.
    Resumable: scores are saved after every fit."""
    f = run.p("results", "tuning.json")
    t = json.loads(f.read_text()) if f.exists() else {}
    if t.get("status") == "done":
        return t
    configs = C.lhs_configs(C.TUNE_SPACE, n, seed=20260 + n, base=LGB_PARAMS)
    ids = [f"c{i}" for i in range(len(configs))]
    scores = {c: dict(t.get("scores", {}).get(c, {})) for c in ids}
    folds = {fd["name"]: fd for fd in sp["folds"]}
    names = [fd["name"] for fd in sp["folds"]]
    lab = Y[f"LABEL{h}"]
    seed = [run.cfg["seeds"][0]]
    fits = int(t.get("fits", 0))

    def save(status="running", **extra):
        C.atomic_write_json(f, {"status": status, "method": "Latin-hypercube random search (Bergstra & Bengio 2012) + successive halving "
                                "(Li et al. 2018), scored on purged validation years; CSCV PBO (Bailey et al. 2017)",
                                "space": C.TUNE_SPACE, "configs": dict(zip(ids, configs)), "scores": scores, "fits": fits, **extra})

    def score(cid, fname):
        nonlocal fits
        if fname in scores[cid]:
            return
        P, _, _ = fit_predict(X, Y, folds[fname], h, seed, params={**LGB_PARAMS, **configs[ids.index(cid)]}, predict="valid")
        ic = Q.qlib_ic(P.iloc[:, 0], lab)
        scores[cid][fname] = float(ic.mean()) if len(ic) else float("nan")
        fits += 1
        save()

    rung1 = C.halving_folds(names)
    log(f"tuning: {len(ids)} configs x {len(rung1)} folds (rung 1), validation years only")
    for cid in ids:
        for fn in rung1:
            score(cid, fn)
    finalists = C.promote({c: {k: v for k, v in scores[c].items() if k in rung1} for c in ids}, min(len(ids), max(4, -(-len(ids) // 3))))
    log(f"tuning: rung 2 = {finalists} on all {len(names)} folds")
    for cid in finalists:
        for fn in names:
            score(cid, fn)
    perf = np.array([[scores[c][fn] for c in finalists] for fn in names])
    pbo = C.cscv_pbo(perf)
    sel = C.tune_select({c: scores[c] for c in finalists}, pbo)
    chosen = sel["chosen"]
    save("done", rung1_folds=rung1, finalists=finalists, pbo=pbo, selection={k: v for k, v in sel.items()},
         chosen=chosen, chosen_params=configs[ids.index(chosen)] if chosen != "c0" else None)
    log(f"tuning: chose {chosen} ({sel['reason']}); {fits} fits")
    return json.loads(f.read_text())


def phase_model(run, args):
    cfg, sp, fa = run.cfg, run.read("splits.json"), run.read("factors.json")
    h = fa["horizon"]
    X, Y = load_xy(run)
    lab = dev_label(run, Y, h)
    n_tune = int(cfg.get("tune_trials", 0) or 0)
    tuning = _tune_lgb(run, X, Y, sp, h, n_tune) if n_tune > 0 else None
    params = _lgb_params(run)
    prog = run.p("results", "model_folds.json")
    folds_done = json.loads(prog.read_text()) if prog.exists() else {}
    for fold in sp["folds"]:
        part = run.p("results", "pred_folds", f"{fold['name']}.pkl")
        if fold["name"] in folds_done and part.exists():
            continue
        t0 = time.time()
        P, cols, iters = fit_predict(X, Y, fold, h, cfg["seeds"], params=params)
        pred = P.mean(axis=1)
        seed_ic = [C.ic_summary(Q.qlib_ic(P[c], lab), h)["mean_ic"] for c in P.columns]
        C.atomic_pickle(part, pred)
        folds_done[fold["name"]] = {"n_features": len(cols), "features": cols, "best_iterations": iters,
                                    "test_ic": C.ic_summary(Q.qlib_ic(pred, lab), h), "seed_test_ic": seed_ic,
                                    "seconds": round(time.time() - t0, 1)}
        C.atomic_write_json(prog, folds_done)
        log(f"  fold {fold['name']}: {len(cols)} feats, iters {iters}, test IC {folds_done[fold['name']]['test_ic']['mean_ic']:+.4f}")
    pred = pd.concat([pd.read_pickle(run.p("results", "pred_folds", f"{f['name']}.pkl")) for f in sp["folds"]]).sort_index()
    C.atomic_pickle(run.p("results", "pred_dev.pkl"), pred)
    s = C.ic_summary(Q.qlib_ic(pred, lab), h)
    sa = Q.signal_analysis(pred, lab, _raw_label(run, Y, h, dev=True), h)
    try:
        ridge = _ridge_baseline(run, X, Y, sp, h, folds_done, lab, pred)
    except Exception as e:  # noqa: BLE001  the baseline is a diagnostic; never fail the main model because of it
        log(f"ridge baseline failed (diagnostic only, main model unaffected): {e}")
        ridge = {"error": str(e)}
    run.write("model.json", {"model": "qlib.contrib.model.gbdt.LGBModel on DatasetH (early stopping on the purged validation year)",
                             "params": params, "seeds": cfg["seeds"], "horizon": h,
                             "tuning": ({**{k: tuning.get(k) for k in ("method", "fits", "finalists", "pbo", "selection", "chosen", "chosen_params", "rung1_folds")},
                                         "n_configs": len(tuning.get("configs", {}))} if tuning else None),
                             "walk_forward_ic": s, "signal_analysis": sa, "folds": folds_done, "ridge_baseline": ridge})
    log(f"model: walk-forward IC {s['mean_ic']:+.4f}, ICIR {s['icir']:.3f}, t(non-overlap) {s['t_nonoverlap']:.2f}")


# ---------------------------------------------------------------------------
# Phase 8: robustness
# ---------------------------------------------------------------------------

def phase_robustness(run, args):
    cfg, sp, fa = run.cfg, run.read("splits.json"), run.read("factors.json")
    h = fa["horizon"]
    X, Y = load_xy(run)
    lab = dev_label(run, Y, h)
    pred = pd.read_pickle(run.p("results", "pred_dev.pkl"))
    ic = Q.qlib_ic(pred, lab)
    real = float(ic.mean())
    ppath = run.p("results", "permutations.json")
    perms = json.loads(ppath.read_text()) if ppath.exists() else []
    for k in range(len(perms), cfg["n_perm"]):
        ps = []
        for fold in sp["folds"]:
            P, _, _ = fit_predict(X, Y, fold, h, [cfg["seeds"][0]], shuffle_seed=1000 + k, params=_lgb_params(run))
            ps.append(P.iloc[:, 0])
        perms.append(float(Q.qlib_ic(pd.concat(ps), lab).mean()))
        C.atomic_write_json(ppath, perms)  # resumable per permutation
        log(f"  permutation {k + 1}/{cfg['n_perm']}: IC {perms[-1]:+.4f}")
    perms_a = np.array(perms)
    pst = C.permutation_p(real, perms_a)
    pval, z = pst["p"], pst["z"]
    by_year = ic.groupby(ic.index.year).mean()
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    cols = run.read("data_audit.json")["tickers_with_data"]
    ew = px["close"][cols].pct_change().where(_eligible(run)[cols].shift(1, fill_value=False)).mean(axis=1)
    yr_ret = (1 + ew).groupby(ew.index.year).prod() - 1
    up = [y for y in by_year.index if yr_ret.get(y, 0) > 0]
    dn = [y for y in by_year.index if yr_ret.get(y, 0) <= 0]
    mj = run.read("model.json")
    seed_ics = np.array([f["seed_test_ic"] for f in mj["folds"].values()])
    if len(perms_a) < 19:
        log(f"WARNING: only {len(perms_a)} permutations; the smallest attainable p is {1 / (1 + len(perms_a)):.3f}, "
            "so the permutation gate cannot pass (test runs only).")
    out = {"real_ic": real, "perm_ics": perms, "perm_p": pval, "perm_z": z, "min_attainable_p": 1 / (1 + len(perms_a)),
           "ic_t_nonoverlap": mj["walk_forward_ic"]["t_nonoverlap"],
           "ic_by_year": {int(k): float(v) for k, v in by_year.items()},
           "years_positive": int((by_year > 0).sum()), "years_total": int(len(by_year)),
           "regime": {"up_years_mean_ic": float(by_year[up].mean()) if up else None,
                      "down_years_mean_ic": float(by_year[dn].mean()) if dn else None,
                      "down_years": dn},
           "seed_ic_range_per_fold": float(np.mean(seed_ics.max(1) - seed_ics.min(1))),
           "verdict": "signal distinguishable from shuffled labels" if pval < 0.05 else
                      "model is NOT distinguishable from shuffled labels"}
    run.write("robustness.json", out)
    log(f"robustness: real IC {real:+.4f}, permutation p={pval:.3f} (z={z:.2f}), "
        f"{out['years_positive']}/{out['years_total']} years positive")


def _advanced_flag(rb):
    """auto rule: try Qlib TRA unless LightGBM is already significant AND stable. A tree model on
    one day's cross-section can miss signal that a sequence model with regime routing finds, so
    "LightGBM found nothing" is not taken as "no signal" without trying the second model class.
    TRA is still adopted only by the pre-set rule and must pass its own permutation control."""
    by = pd.Series(rb["ic_by_year"])
    if rb["perm_p"] >= 0.05:
        return True, ("LightGBM is not distinguishable from shuffled labels: a second model class (Qlib TRA, "
                      "sequence + regime routing) is tried on the development folds before concluding")
    if (by < 0).sum() >= len(by) / 3:
        return True, "significant but regime-unstable IC: a regime-adaptive model (Qlib TRA) is justified"
    return False, "LightGBM signal is significant and stable; no specific deficiency to address"


def _tra_permutation(run, h, lab, real_ic, names):
    """Permutation control for TRA (run only when TRA is selected): n_perm_tra full refits on the
    development folds with within-date shuffled training labels; resumable per fold."""
    cfg = run.cfg
    n = int(cfg.get("n_perm_tra", 20))
    if n <= 0:
        return {"ran": False, "p": None, "n": 0, "note": "disabled with --n-perm-tra 0"}
    seed = cfg["seeds"][0]
    log(f"advanced: TRA selected; running its permutation control ({n} shuffled-label refits on "
        f"{len(names)} folds; resumable)")
    _run_jobs(run, [("tra", seed, f"perm{k}") for k in range(n)])
    ics = []
    for k in range(n):
        P = _load_job_preds(run, "tra", [seed], names, sub=f"tra_perm{k}")
        ics.append(float(Q.qlib_ic(P.iloc[:, 0], lab).mean()))
    st = C.permutation_p(real_ic, ics)
    return {"ran": True, "perm_ics": ics, **st}


def _run_jobs(run, jobs, folds=None):
    """Run TRA/RNN jobs as parallel subprocesses (each checkpoints per fold). jobs: (kind, seed)
    pairs that all use `folds`, or (kind, seed, folds) triples."""
    import subprocess
    ldir = run.p("results", "advanced", "logs")
    ldir.mkdir(parents=True, exist_ok=True)
    width = max(1, min(len(jobs), (os.cpu_count() or 4) // 2))
    env = {**os.environ, "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2"}
    pending, active = [j if len(j) == 3 else (j[0], j[1], folds) for j in jobs], []
    while pending or active:
        while pending and len(active) < width:
            kind, seed, fl = pending.pop(0)
            lf = open(ldir / f"{kind}_s{seed}_{fl}.log", "a")
            pr = subprocess.Popen([sys.executable, os.path.abspath(__file__), "tra-job", "--run-dir", str(run.dir),
                                   "--kind", kind, "--seed", str(seed), "--folds", fl],
                                  stdout=lf, stderr=subprocess.STDOUT, env=env, cwd="/tmp")
            active.append((kind, seed, pr, lf, fl))
        time.sleep(5)
        for a in list(active):
            if a[2].poll() is not None:
                a[3].close()
                active.remove(a)
                if a[2].returncode != 0:
                    tail = (ldir / f"{a[0]}_s{a[1]}_{a[4]}.log").read_text()[-1500:]
                    raise RuntimeError(f"{a[0]} seed {a[1]} ({a[4]}) failed:\n{tail}")
                log(f"  {a[0]} seed {a[1]} ({a[4]}) done")


def tra_job(run_dir, kind, seed, folds):
    import qlib
    from qlib.constant import REG_US
    import qs_tra
    run = Run(Path(run_dir))
    da, sp, fa = run.read("data_audit.json"), run.read("splits.json"), run.read("factors.json")
    qlib.init(provider_uri=da["provider_uri"], region=REG_US, kernels=1)
    h = fa["horizon"]
    X, Y = load_xy(run)
    elig = Y["ELIGIBLE"] > 0
    shuffle_seed, out_dir = None, f"{kind}_s{seed}"
    if folds.startswith("perm"):
        # TRA permutation control k: development folds, training labels shuffled with the same
        # seeds (1000 + k) as LightGBM's control; one model seed per permutation.
        k = int(folds[4:])
        shuffle_seed, out_dir = 1000 + k, f"{kind}_perm{k}"
    if folds == "dev" or shuffle_seed is not None:
        lab = dev_label(run, Y, h)
        todo = [(f, json.loads(run.p("results", "model_folds.json").read_text())[f["name"]]["features"]) for f in sp["folds"]]
    else:
        lab = Y[f"LABEL{h}"]
        f = sp["final"]
        tr = _between(X.index, *f["train"]) & lab.notna().values
        todo = [(f, select_features(X[tr], lab[tr], h))]
    lr = _rank_label(lab)
    for fold, feats in todo:
        out = run.p("results", "advanced", out_dir, f"{fold['name']}.pkl")
        if out.exists():
            continue
        t0 = time.time()
        pred = qs_tra.tra_fold(X, lr, elig, fold, h, feats, seed=seed, kind=kind, shuffle_seed=shuffle_seed)
        C.atomic_pickle(out, pred)
        print(f"{out_dir} fold {fold['name']}: {len(pred)} preds in {time.time() - t0:.0f}s", flush=True)


def _load_job_preds(run, kind, seeds, names, sub=None):
    cols = []
    for sd in seeds:
        d = sub.format(sd) if sub else f"{kind}_s{sd}"
        cols.append(pd.concat([pd.read_pickle(run.p("results", "advanced", d, f"{n}.pkl")) for n in names]))
    return pd.concat(cols, axis=1, keys=seeds)


def phase_advanced(run, args):
    cfg, rb, sp, fa = run.cfg, run.read("robustness.json"), run.read("splits.json"), run.read("factors.json")
    h = fa["horizon"]
    flagged, reason = _advanced_flag(rb)
    lgb = pd.read_pickle(run.p("results", "pred_dev.pkl"))
    mode = cfg.get("advanced", "auto")
    if mode == "off" or (mode == "auto" and not flagged):
        C.atomic_pickle(run.p("results", "pred_dev_selected.pkl"), lgb)
        run.write("advanced.json", {"flagged": flagged, "reason": reason, "ran": False, "selected": "lightgbm",
                                    "decision": f"Not run ({'disabled' if mode == 'off' else reason})."})
        log(f"advanced: not run — {reason}")
        return
    log(f"advanced: running Qlib TRA and its plain-RNN backbone on the {len(sp['folds'])} development folds "
        f"({'flagged: ' if flagged else 'requested with --advanced tra; auto rule says: '}{reason})")
    _run_jobs(run, [(k, sd) for k in ("tra", "rnn") for sd in cfg["seeds"]], "dev")
    Y = pd.read_pickle(run.p("data", "labels.pkl"))
    lab = dev_label(run, Y, h)
    names = [f["name"] for f in sp["folds"]]
    ic_l = Q.qlib_ic(lgb, lab)
    res = {"lightgbm": {"ic": C.ic_summary(ic_l, h), "by_year": ic_l.groupby(ic_l.index.year).mean().round(4).to_dict()}}
    preds = {"lightgbm": lgb}
    for kind in ("tra", "rnn"):
        P = _load_job_preds(run, kind, cfg["seeds"], names)
        ens = P.mean(axis=1)
        preds[kind] = ens
        ic_k = Q.qlib_ic(ens, lab)
        d = (ic_k - ic_l).dropna()
        no = d.iloc[::h]
        res[kind] = {"ic": C.ic_summary(ic_k, h), "by_year": ic_k.groupby(ic_k.index.year).mean().round(4).to_dict(),
                     "seed_mean_ic": [float(Q.qlib_ic(P[sd], lab).mean()) for sd in cfg["seeds"]],
                     "paired_vs_lgb": {"mean_diff": float(d.mean()),
                                       "t_nonoverlap": float(no.mean() / (no.std() / np.sqrt(len(no)))) if len(no) > 2 else float("nan"),
                                       "years_better": int((ic_k.groupby(ic_k.index.year).mean() > ic_l.groupby(ic_l.index.year).mean()).sum()),
                                       "years": int(ic_l.index.year.nunique())}}
    t = res["tra"]
    rule = {"mean IC gain > 0.005": t["paired_vs_lgb"]["mean_diff"] > 0.005,
            "paired t (non-overlapping) > 2": t["paired_vs_lgb"]["t_nonoverlap"] > 2,
            "every seed beats LightGBM": all(x > res["lightgbm"]["ic"]["mean_ic"] for x in t["seed_mean_ic"]),
            "TRA IC t-stat > 2": t["ic"]["t_nonoverlap"] > 2}
    selected = "tra" if all(rule.values()) else "lightgbm"
    # Informational only, never selectable: rank-average blend of LightGBM and TRA (the SOX
    # research's best ensemble style), so the report shows whether combining would have helped.
    blend = (lgb.groupby(level=0).rank(pct=True).reindex(preds["tra"].index)
             + preds["tra"].groupby(level=0).rank(pct=True)) / 2
    ic_b = Q.qlib_ic(blend.dropna(), lab)
    res["blend_rank_avg"] = {"ic": C.ic_summary(ic_b, h), "by_year": ic_b.groupby(ic_b.index.year).mean().round(4).to_dict(),
                             "note": "informational only; not a selection candidate"}
    preds["blend_rank_avg"] = blend.dropna()
    tra_perm = _tra_permutation(run, h, lab, t["ic"]["mean_ic"], names) if selected == "tra" else {"ran": False}
    # Informational only (not used for selection): same simple construction for every model.
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    start, end = pd.Timestamp(sp["folds"][0]["test"][0]), pd.Timestamp(sp["folds"][-1]["test"][1])
    sig = [d for d in C.rebalance_dates(px["close"].index, start, end, h) if d < end]
    k = int(np.clip(round(len(_universe_cols(run)) / 5), 3, 30))
    for name, pr in preds.items():
        sim = _sim(run, _targets(run, _score_matrix(pr), sig, k, None), cfg["cost_bps"], start, end)
        res[name]["dev_portfolio_topk%d" % k] = {kk: Q.sim_stats(sim)[kk] for kk in ("cagr", "sharpe", "max_drawdown")}
    C.atomic_pickle(run.p("results", "pred_dev_selected.pkl"), preds[selected])
    gates = ({"model": "TRA", "ic_t": t["ic"]["t_nonoverlap"], "perm_p": tra_perm.get("p"),
              "perm_n": tra_perm.get("n", 0)} if selected == "tra" else None)
    run.write("advanced.json", {"flagged": flagged, "reason": reason, "ran": True, "selected": selected,
                                "selection_rule": rule, "results": res, "tra_permutation": tra_perm,
                                "selected_dev_gates": gates,
                                "config": {"model": "qlib.contrib.model.pytorch_tra.TRAModel on MTSDatasetH",
                                           "tra": "3 states, router transport, LR_TPE memory, GRU hidden 32 + attention",
                                           "rnn": "same backbone, 1 state, no routing",
                                           "seq_len": h + 21, "memory_horizon_mask": h + 1, "seeds": cfg["seeds"],
                                           "budget": "<=20 epochs, early stop 4, 100 steps x 1024 samples per epoch, lr 1e-3"},
                                "decision": f"{'TRA selected' if selected == 'tra' else 'LightGBM kept'} by the pre-set rule "
                                            f"(development folds only): {rule}"})
    log(f"advanced: TRA IC {t['ic']['mean_ic']:+.4f} (t {t['ic']['t_nonoverlap']:.2f}) vs LightGBM "
        f"{res['lightgbm']['ic']['mean_ic']:+.4f}; RNN {res['rnn']['ic']['mean_ic']:+.4f}; "
        f"blend {res['blend_rank_avg']['ic']['mean_ic']:+.4f} (info only); selected: {selected}"
        + (f"; TRA permutation p={tra_perm['p']:.3f}" if tra_perm.get("p") is not None else ""))


# ---------------------------------------------------------------------------
# Phase 10/11: portfolio construction + overlay (development period only)
# ---------------------------------------------------------------------------

def _score_matrix(pred):
    return pred.unstack()


def _universe_cols(run):
    return run.read("data_audit.json")["tickers_with_data"]


def baseline_suite(run, opens, closes, sig_dates, k, n_drop, cost, start, end, n_random, h, strat_targets):
    """Equal-weight members, ETF buy-and-hold, and turnover-matched momentum and random portfolios:
    the latter two hold as many names per sector as the strategy and replace as many at each
    rebalance as the strategy did (qs_core.matched_targets), so they pay the same trading costs."""
    cols = _universe_cols(run)
    grp = _sectors(run) if _neutral(run.cfg) else None
    out = {}
    avail = _eligible(run)[cols].reindex(closes.index, fill_value=False)
    ew_t = {d: pd.Series(1.0 / avail.loc[d].sum(), index=avail.columns[avail.loc[d]]) for d in sig_dates}
    out["Equal-weight universe"] = _sim(run, ew_t, cost, start, end)
    mom = (closes[cols] / closes[cols].shift(h) - 1).where(avail)
    out["Momentum top-K"] = _sim(run, C.matched_targets(mom, strat_targets, grp), cost, start, end)
    bench = run.read("universe.json")["benchmark_etf"]
    if bench and bench in closes and closes[bench].loc[start:end].notna().sum() > 20:
        out[f"{bench} buy-and-hold"] = _sim(run, {sig_dates[0]: pd.Series({bench: 1.0})}, cost, start, end)
    rnd = []
    for i in range(n_random):
        rng = np.random.default_rng(i)
        sc = pd.DataFrame(rng.random((len(sig_dates), len(cols))), index=sig_dates, columns=cols).where(avail.loc[sig_dates])
        rnd.append(Q.perf(_sim(run, C.matched_targets(sc, strat_targets, grp), cost, start, end)["nav"])["sharpe"])
    return out, np.array(rnd)


def _vol_exposure(unscaled_ret: pd.Series, sig_dates, tv, lb, floor=0.2):
    return C.vol_exposure(unscaled_ret, sig_dates, tv, lb, floor)


def phase_portfolio(run, args):
    cfg, sp, fa = run.cfg, run.read("splits.json"), run.read("factors.json")
    h = fa["horizon"]
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    opens, closes = px["open"], px["close"]
    scores = _score_matrix(pd.read_pickle(run.p("results", "pred_dev_selected.pkl")))
    start, end = pd.Timestamp(sp["folds"][0]["test"][0]), pd.Timestamp(sp["folds"][-1]["test"][1])
    sig = C.rebalance_dates(closes.index, start, end, h)
    sig = [d for d in sig if d < end]
    n = len(_universe_cols(run))
    ks = sorted({int(np.clip(round(n * f), 3, 30)) for f in (0.1, 0.2, 1 / 3)})
    grid = []
    for k in ks:
        for nd in ((None,) if _neutral(cfg) else (None, max(1, k // 4))):
            sim = _sim(run, _targets(run, scores, sig, k, nd), cfg["cost_bps"], start, end)
            st = Q.sim_stats(sim)
            grid.append({"topk": k, "n_drop": nd, **st})
            run.explog({"phase": "portfolio", "topk": k, "n_drop": nd, "sharpe": st["sharpe"], "cagr": st["cagr"]})
    best = max(grid, key=lambda g: g["sharpe"])
    k, nd = best["topk"], best["n_drop"]
    strat = _sim(run, _targets(run, scores, sig, k, nd), cfg["cost_bps"], start, end)
    base, rnd = baseline_suite(run, opens, closes, sig, k, nd, cfg["cost_bps"], start, end, cfg["n_random"], h,
                               _targets(run, scores, sig, k, nd))
    costs = {}
    for bps in (0, 5, 10, 25, 50):
        s_ = _sim(run, _targets(run, scores, sig, k, nd), bps, start, end)
        e_ = _sim(run, {d: v for d, v in _ew_targets(run, closes, sig).items()}, bps, start, end)
        costs[bps] = {"strategy_cagr": Q.perf(s_["nav"])["cagr"], "strategy_sharpe": Q.perf(s_["nav"])["sharpe"],
                      "ew_cagr": Q.perf(e_["nav"])["cagr"]}
    diffs = [(b, v["strategy_cagr"] - v["ew_cagr"]) for b, v in costs.items()]
    be = None
    for (b0, d0), (b1, d1) in zip(diffs, diffs[1:]):
        if d0 > 0 >= d1:
            be = round(b0 + (b1 - b0) * d0 / (d0 - d1), 1)
    if be is None:
        be = "never ahead of equal-weight" if diffs[0][1] <= 0 else ">50"
    ls = _long_short(run, opens, closes, scores, sig, k, cfg["cost_bps"], start, end)
    C.atomic_pickle(run.p("results", "dev_navs.pkl"), {"Strategy (pre-overlay)": strat, **base})
    run.write("portfolio.json", {
        "rebalance_every_days": h, "signal_dates": len(sig), "grid": grid, "n_trials": len(grid),
        "chosen": {"topk": k, "n_drop": nd}, "strategy": Q.sim_stats(strat),
        "baselines": {n_: Q.sim_stats(s_) for n_, s_ in base.items()},
        "random_sharpe": {"mean": float(rnd.mean()), "p05": float(np.percentile(rnd, 5)),
                          "p95": float(np.percentile(rnd, 95)), "n": int(len(rnd))},
        "cost_sensitivity": costs, "breakeven_cost_bps_vs_ew": be,
        "excess_vs_ew": Q.excess(strat["nav"], base["Equal-weight universe"]["nav"]),
        "long_short": ls, "construction": "sector-balanced top-K" if _neutral(cfg) else "top-K",
        "baseline_construction": "turnover-matched (qs_core.matched_targets)",
        "note": f"{len(grid)} construction variants were tried on the development period; "
                "the best is optimistic by selection (not by leakage)."})
    log(f"portfolio: topk={k}, n_drop={nd}; dev Sharpe {best['sharpe']:.2f} vs EW "
        f"{Q.perf(base['Equal-weight universe']['nav'])['sharpe']:.2f}, random p95 {np.percentile(rnd, 95):.2f}")


def _eligible(run):
    return pd.read_pickle(run.p("data", "eligible.pkl"))


def _ew_targets(run, closes, sig):
    cols = _universe_cols(run)
    avail = _eligible(run)[cols].reindex(closes.index, fill_value=False)
    return {d: pd.Series(1.0 / avail.loc[d].sum(), index=avail.columns[avail.loc[d]]) for d in sig}


def _ew_ret(run):
    """Daily return of the equal-weight eligible universe (the market for the trend filter)."""
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    cols = _universe_cols(run)
    return px["close"][cols].pct_change().where(_eligible(run)[cols].shift(1, fill_value=False)).mean(axis=1)


def _overlay_ex(run, ov, unscaled_ret, sig):
    """Exposure dict for the chosen overlay (None when no overlay is kept). Old runs stored only
    vol-scaling parameters without a family name."""
    if not ov.get("use_overlay"):
        return None
    fam = ov.get("chosen_family", "vol_target")
    return C.overlay_exposure(fam, ov["chosen"], unscaled_ret, _ew_ret(run), sig)


def phase_overlay(run, args):
    cfg, sp, fa, pf = run.cfg, run.read("splits.json"), run.read("factors.json"), run.read("portfolio.json")
    h, k, nd = fa["horizon"], pf["chosen"]["topk"], pf["chosen"]["n_drop"]
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    closes = px["close"]
    scores = _score_matrix(pd.read_pickle(run.p("results", "pred_dev_selected.pkl")))
    start, end = pd.Timestamp(sp["folds"][0]["test"][0]), pd.Timestamp(sp["folds"][-1]["test"][1])
    sig = [d for d in C.rebalance_dates(closes.index, start, end, h) if d < end]
    navs = pd.read_pickle(run.p("results", "dev_navs.pkl"))
    base_ret = navs["Strategy (pre-overlay)"]["nav"].pct_change()
    base_sh = Q.perf(navs["Strategy (pre-overlay)"]["nav"])["sharpe"]
    mkt = _ew_ret(run)
    results, grid = {}, []
    for fam, pts in C.OVERLAY_GRIDS.items():
        results[fam] = []
        for prm in pts:
            ex = C.overlay_exposure(fam, prm, base_ret, mkt, sig)
            st = Q.sim_stats(_sim(run, _targets(run, scores, sig, k, nd, ex), cfg["cost_bps"], start, end))
            row = {"family": fam, **prm, "sharpe": st["sharpe"], "cagr": st["cagr"],
                   "max_drawdown": st["max_drawdown"], "delta_sharpe": st["sharpe"] - base_sh}
            grid.append(row)
            results[fam].append({"params": prm, "delta_sharpe": row["delta_sharpe"]})
            run.explog({"phase": "overlay", **{kk: v for kk, v in row.items() if kk != "delta_sharpe"}})
    ch = C.choose_overlay(results)
    use = ch["chosen_family"] is not None
    if use:
        ex = C.overlay_exposure(ch["chosen_family"], ch["chosen"], base_ret, mkt, sig)
        navs["Strategy"] = _sim(run, _targets(run, scores, sig, k, nd, ex), cfg["cost_bps"], start, end)
    else:
        navs["Strategy"] = navs["Strategy (pre-overlay)"]
    C.atomic_pickle(run.p("results", "dev_navs.pkl"), navs)
    fams = ch["families"]
    run.write("overlay.json", {
        "grid": grid, "n_trials": len(grid), "pre_overlay_sharpe": base_sh, "families": fams,
        "fraction_of_grid_improving": float(np.mean([g["delta_sharpe"] > 0 for g in grid])),
        "use_overlay": use, "chosen_family": ch["chosen_family"], "chosen": ch["chosen"],
        "rule": "per family: keep only if its best dSharpe >= 0.10 AND >= 60% of its own grid improves "
                "(smooth surface); among qualifying families the largest gain wins",
        "definitions": {"vol_target": "target / trailing std of the un-scaled strategy's own daily returns, floor 0.2",
                        "drawdown_control": "invest `cut` while the un-scaled strategy is >= threshold below its peak",
                        "trend_filter": "invest `cut` while the equal-weight universe is below its moving average"}})
    log("overlay: " + (f"{ch['chosen_family']} {ch['chosen']}" if use else "none") + " ("
        + "; ".join(f"{f} best dSharpe {v['best_delta_sharpe']:+.2f}, {v['fraction_improving']:.0%} improve"
                    for f, v in fams.items()) + ")")


# ---------------------------------------------------------------------------
# Phase 12: holdout (run once; every attempt is logged)
# ---------------------------------------------------------------------------

REGISTRY = CACHE / "holdout_registry.json"


def _registry_key(cfg):
    target = cfg["target"].lower()
    if target == "custom":
        # Each custom ticker list is its own holdout: key on the normalized, order-free list
        # so unrelated custom universes no longer share (and contaminate) one "CUSTOM" entry.
        names = sorted({t.strip().upper() for t in re.split(r"[,\s]+", cfg.get("tickers") or "") if t.strip()})
        return "CUSTOM_" + hashlib.sha1(",".join(names).encode()).hexdigest()[:10]
    return ALIASES.get(target, target).upper()


def _registry_prior(run, start, end):
    reg = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else []
    key = _registry_key(run.cfg)
    out = []
    for r in reg:
        a, b = pd.Timestamp(r["window"][0]), pd.Timestamp(r["window"][1])
        if r["key"] == key and r["run_dir"] != str(run.dir) and a <= end and b >= start:
            out.append({**r, "overlap": [str(max(a, start).date()), str(min(b, end).date())],
                        "overlap_days": int(len(pd.bdate_range(max(a, start), min(b, end))))})
    return out


def _registry_add(run, start, end):
    reg = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else []
    reg.append({"key": _registry_key(run.cfg), "window": [str(start.date()), str(end.date())],
                "run_dir": str(run.dir), "at": dt.datetime.now().isoformat(timespec="seconds"),
                "synthetic_null_test": bool(run.cfg.get("null_signal"))})
    C.atomic_write_json(REGISTRY, reg)


def phase_holdout(run, args):
    cfg, sp, fa = run.cfg, run.read("splits.json"), run.read("factors.json")
    pf, ov, rb = run.read("portfolio.json"), run.read("overlay.json"), run.read("robustness.json")
    lock = run.p("holdout_attempts.json")
    attempts = json.loads(lock.read_text()) if lock.exists() else []
    finished = [a for a in attempts if a.get("completed")]
    if finished and not args.force_holdout:
        raise RuntimeError(f"Holdout already evaluated {len(finished)} time(s) "
                           f"({finished[-1]['at']}). Re-running it would no longer be untouched. "
                           "Pass --force-holdout only if you accept that; the report will say so.")
    if not attempts or attempts[-1].get("completed"):
        attempts.append({"at": dt.datetime.now().isoformat(timespec="seconds"), "config_hash": cfg["config_hash"]})
    else:
        attempts[-1]["resumed_after_interruption"] = dt.datetime.now().isoformat(timespec="seconds")
    C.atomic_write_json(lock, attempts)
    h, k, nd = fa["horizon"], pf["chosen"]["topk"], pf["chosen"]["n_drop"]
    start, end = pd.Timestamp(sp["holdout_start"]), pd.Timestamp(sp["end"])
    prior = _registry_prior(run, start, end)
    hstatus = "untouched" if not prior else "PREVIOUSLY EXAMINED"
    if prior:
        log(f"WARNING: holdout window overlaps {len(prior)} earlier evaluation(s) of {_registry_key(cfg)} "
            f"({prior[0]['run_dir']} at {prior[0]['at']}); this is NOT an untouched test.")
    X, Y = load_xy(run)
    lab = Y[f"LABEL{h}"]
    selected = run.read("advanced.json").get("selected", "lightgbm")
    if selected == "tra":
        _run_jobs(run, [("tra", sd) for sd in cfg["seeds"]], "final")
        pred = _load_job_preds(run, "tra", cfg["seeds"], ["holdout"]).mean(axis=1)
        cols, iters = "TRA (see advanced.json)", None
    else:
        P, cols, iters = fit_predict(X, Y, sp["final"], h, cfg["seeds"], params=_lgb_params(run))
        pred = P.mean(axis=1)
    C.atomic_pickle(run.p("results", "pred_holdout.pkl"), pred)
    ic = C.ic_summary(Q.qlib_ic(pred, lab), h)
    sa = Q.signal_analysis(pred, lab, _raw_label(run, Y, h, dev=False), h)
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    opens, closes = px["open"], px["close"]
    sig = [d for d in C.rebalance_dates(closes.index, start, end, h) if d < end]
    scores = _score_matrix(pred)
    unscaled = _sim(run, _targets(run, scores, sig, k, nd), cfg["cost_bps"], start, end)
    if ov["use_overlay"]:
        dev = pd.read_pickle(run.p("results", "dev_navs.pkl"))["Strategy (pre-overlay)"]["nav"].pct_change()
        r = pd.concat([dev, unscaled["nav"].pct_change().iloc[1:]])
        r = r[~r.index.duplicated(keep="last")]
        ex = _overlay_ex(run, ov, r, sig)
        strat = _sim(run, _targets(run, scores, sig, k, nd, ex), cfg["cost_bps"], start, end)
    else:
        ex, strat = None, unscaled
    base, rnd = baseline_suite(run, opens, closes, sig, k, nd, cfg["cost_bps"], start, end, cfg["n_random"], h,
                               _targets(run, scores, sig, k, nd))
    costs = {}
    for bps in (0, 5, 10, 25, 50):
        s_ = _sim(run, _targets(run, scores, sig, k, nd, ex), bps, start, end)
        costs[bps] = Q.perf(s_["nav"])
    ew = base["Equal-weight universe"]["nav"]
    ex_ew = Q.excess(strat["nav"], ew)
    ls = _long_short(run, opens, closes, scores, sig, k, cfg["cost_bps"], start, end)
    boot = C.block_bootstrap_sharpe(strat["nav"].pct_change(), seed=7)
    C.atomic_pickle(run.p("results", "holdout_navs.pkl"), {"Strategy": strat, **base})
    dev_navs = pd.read_pickle(run.p("results", "dev_navs.pkl"))
    adv = run.read("advanced.json")
    sel_g = adv.get("selected_dev_gates") if adv.get("selected") == "tra" else None
    if adv.get("selected") == "tra" and not sel_g:  # run made before TRA had its own permutation control
        sel_g = {"model": "TRA", "ic_t": adv["results"]["tra"]["ic"]["t_nonoverlap"], "perm_p": None}
    dev = {"model": sel_g["model"] if sel_g else "LightGBM",
           "ic_t": sel_g["ic_t"] if sel_g else rb["ic_t_nonoverlap"],
           "perm_p": sel_g["perm_p"] if sel_g else rb["perm_p"],
           "sharpe_net": Q.perf(dev_navs["Strategy"]["nav"])["sharpe"],
           "ew_sharpe": pf["baselines"]["Equal-weight universe"]["sharpe"],
           "momentum_sharpe": pf["baselines"]["Momentum top-K"]["sharpe"],
           "random_p95_sharpe": pf["random_sharpe"]["p95"]}
    hold = {"ic_mean": ic["mean_ic"], "excess_vs_ew": ex_ew["ann_excess_arith"], "sharpe_net": Q.perf(strat["nav"])["sharpe"],
            "sharpe_ci_lo": boot["lo"], "random_p95_sharpe": float(np.percentile(rnd, 95))}
    v = C.verdict(dev, hold)
    if cfg["null_signal"]:
        v["verdict"] += "  [SYNTHETIC NULL-SIGNAL TEST RUN]"
    if prior:
        v["verdict"] += "  [holdout period previously examined — not an untouched test]"
    run.write("holdout_results.json", {
        "attempt": len([a for a in attempts if a.get("completed")]) + 1, "window": [str(start.date()), str(end.date())], "features": cols,
        "best_iterations": iters, "model": selected, "holdout_status": hstatus,
        "previous_examinations": prior, "ic": ic, "signal_analysis": sa, "strategy": Q.sim_stats(strat),
        "baselines": {n_: Q.sim_stats(s_) for n_, s_ in base.items()},
        "random_sharpe": {"mean": float(rnd.mean()), "p95": float(np.percentile(rnd, 95))},
        "excess_vs_ew": ex_ew, "long_short": ls, "sharpe_bootstrap_95ci": boot, "cost_sensitivity": costs,
        "gates_dev": dev, "gates_holdout": hold, **v})
    log(f"holdout ({hstatus.lower()}; evaluation {len(attempts)} in this run folder): IC {ic['mean_ic']:+.4f}, Sharpe {hold['sharpe_net']:.2f} "
        f"[{boot['lo']:.2f}, {boot['hi']:.2f}], excess vs EW {ex_ew['ann_excess_arith']:+.2%}")
    attempts[-1]["completed"] = True
    C.atomic_write_json(lock, attempts)
    _registry_add(run, start, end)
    log(f"VERDICT: {v['verdict']}")


# ---------------------------------------------------------------------------
# Phase 13: report
# ---------------------------------------------------------------------------

COLORS = {"Strategy": "#2a78d6", "Equal-weight universe": "#1baf7a", "Momentum top-K": "#8a8984"}
BENCH_COLOR = "#eb6834"


def _chain(dev, hold):
    if dev is None:
        return hold
    return pd.concat([dev, hold.iloc[1:] / hold.iloc[0] * dev.iloc[-1]])


def _plots(run, series: dict, holdout_start, h_ic, title="NAV per unit, net of costs"):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                         "axes.edgecolor": "#8a8984", "axes.grid": True, "grid.color": "#e6e5e0",
                         "grid.linewidth": 0.6, "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb"})
    pdir = run.p("plots")
    pdir.mkdir(exist_ok=True)
    col = lambda n: COLORS.get(n, BENCH_COLOR)
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 6.5), sharex=True, gridspec_kw={"height_ratios": [2.2, 1]})
    for n, s in series.items():
        a1.plot(s.index, s.values, lw=2 if n == "Strategy" else 1.4, color=col(n), label=n,
                ls="--" if n == "Momentum top-K" else "-")
        a2.plot(s.index, (s / s.cummax() - 1).values * 100, lw=1.4, color=col(n), ls="--" if n == "Momentum top-K" else "-")
    # end-of-line value labels, nudged apart (log axis) so they never overlap
    ends = sorted(((s_.iloc[-1], n) for n, s_ in series.items()), key=lambda x: x[0])
    placed = []
    for v, n in ends:
        y = v if not placed else max(v, placed[-1] * 1.07)
        placed.append(y)
        a1.annotate(f"{v:.2f}", (list(series.values())[0].index[-1], y), xytext=(4, 0), textcoords="offset points",
                    color="#52514e", va="center", fontsize=8)
    for a in (a1, a2):
        a.axvspan(holdout_start, list(series.values())[0].index[-1], color="#e6e5e0", alpha=0.6, lw=0)
    a2.text(holdout_start, a2.get_ylim()[0], " holdout", va="bottom", fontsize=8, color="#52514e")
    a1.set_yscale("log")
    from matplotlib.ticker import FuncFormatter, LogLocator
    a1.yaxis.set_major_locator(LogLocator(base=10, subs=(1.0, 2.0, 5.0)))
    a1.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
    a1.yaxis.set_minor_formatter(FuncFormatter(lambda v, _: ""))
    a1.set_ylabel("NAV per unit (start = 1.00, log scale)")
    a1.set_title(title, loc="left")
    a1.legend(frameon=False, loc="upper left")
    a2.set_ylabel("Drawdown (%)")
    fig.tight_layout()
    fig.savefig(pdir / "nav_drawdown.png", dpi=150)
    plt.close(fig)
    ann = pd.DataFrame({n: C.annual_returns(s) for n, s in series.items()}) * 100
    fig, ax = plt.subplots(figsize=(10, 4))
    w = 0.8 / len(ann.columns)
    for i, n in enumerate(ann.columns):
        ax.bar(ann.index + (i - (len(ann.columns) - 1) / 2) * w, ann[n].values, width=w * 0.92, color=col(n), label=n)
    ax.axhline(0, color="#52514e", lw=0.8)
    ax.set_ylabel("Calendar-year return (%)")
    ax.legend(frameon=False, ncol=len(ann.columns), loc="lower left", bbox_to_anchor=(0, 1.02))
    ax.set_title("Annual returns, net of costs (first and last years partial)", loc="left", pad=28)
    fig.tight_layout()
    fig.savefig(pdir / "annual_returns.png", dpi=150)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(10, 3.2))
    ax.bar(h_ic.index.astype(str), h_ic.values, color=["#2a78d6" if v > 0 else "#e34948" for v in h_ic.values])
    ax.axhline(0, color="#52514e", lw=0.8)
    ax.set_title("Mean rank IC by year (walk-forward test years, then holdout)", loc="left")
    fig.tight_layout()
    fig.savefig(pdir / "ic_by_year.png", dpi=150)
    plt.close(fig)
    return ann


def concentration(run, top=5):
    """Holdout diagnostic (no refit, no tuning): which names were held most, and the holdout
    CAGR when each of them is removed from the frozen strategy's candidate list."""
    cfg, sp, fa, pf, ov = run.cfg, run.read("splits.json"), run.read("factors.json"), run.read("portfolio.json"), run.read("overlay.json")
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    o, c = px["open"], px["close"]
    scores = _score_matrix(pd.read_pickle(run.p("results", "pred_holdout.pkl")))
    start, end = pd.Timestamp(sp["holdout_start"]), pd.Timestamp(sp["end"])
    sig = [d for d in C.rebalance_dates(c.index, start, end, fa["horizon"]) if d < end]
    k, nd = pf["chosen"]["topk"], pf["chosen"]["n_drop"]
    full = _sim(run, _targets(run, scores, sig, k, nd), cfg["cost_bps"], start, end)
    held = pd.Series([t for w in _targets(run, scores, sig, k, nd).values() for t in w.index]).value_counts()
    out = {"note": "un-overlaid strategy" if ov["use_overlay"] else "strategy", "rebalances": len(sig),
           "full_cagr": Q.perf(full["nav"])["cagr"], "names": []}
    for t in held.index[:top]:
        s_ = _sim(run, _targets(run, scores.drop(columns=[t]), sig, k, nd), cfg["cost_bps"], start, end)
        out["names"].append({"ticker": t, "times_held": int(held[t]), "cagr_without": Q.perf(s_["nav"])["cagr"],
                             "name_total_return": float(c[t].loc[start:end].dropna().iloc[-1] / c[t].loc[start:end].dropna().iloc[0] - 1)})
    return out


def _prior_md(r):
    txt = f"{r['run_dir']} at {r['at']}"
    if r.get("overlap"):
        txt += f", overlap {r['overlap'][0]} to {r['overlap'][1]} ({r['overlap_days']} business days)"
    return txt


def _advanced_md(ad):
    if not ad.get("ran"):
        return []
    r = ad["results"]
    out = ["Development-fold comparison (no holdout data used; selection rule fixed in code before running):", "",
           "| Model | Mean IC | ICIR | t (non-overlap) | vs LightGBM: mean diff / paired t / years better | Seed ICs | Dev CAGR / Sharpe (same simple top-K) |",
           "|---|---:|---:|---:|---|---|---|"]
    for name, lab in [("lightgbm", "LightGBM"), ("rnn", "Qlib TRA backbone, 1 state (RNN)"), ("tra", "Qlib TRA, 3 states + router")]:
        x = r[name]
        pv = x.get("paired_vs_lgb")
        port = next((v for k, v in x.items() if k.startswith("dev_portfolio")), {})
        out.append(f"| {lab} | {x['ic']['mean_ic']:+.4f} | {x['ic']['icir']:.3f} | {x['ic']['t_nonoverlap']:.2f} | "
                   + (f"{pv['mean_diff']:+.4f} / {pv['t_nonoverlap']:.2f} / {pv['years_better']}/{pv['years']}" if pv else "—")
                   + f" | {', '.join(f'{v:+.4f}' for v in x.get('seed_mean_ic', [])) or '—'} | "
                   f"{_pct(port.get('cagr'))} / {port.get('sharpe', float('nan')):.2f} |")
    if "blend_rank_avg" in r:
        b = r["blend_rank_avg"]
        port = next((v for k, v in b.items() if k.startswith("dev_portfolio")), {})
        out.append(f"| Rank-average blend of LightGBM and TRA (information only, never selected) | {b['ic']['mean_ic']:+.4f} | "
                   f"{b['ic']['icir']:.3f} | {b['ic']['t_nonoverlap']:.2f} | — | — | "
                   f"{_pct(port.get('cagr'))} / {port.get('sharpe', float('nan')):.2f} |")
    out += ["", f"Selection: **{ad['selected']}**. Rule: " + "; ".join(f"{k}: {'yes' if v else 'no'}" for k, v in ad["selection_rule"].items()) + "."]
    tp = ad.get("tra_permutation") or {}
    if tp.get("ran"):
        out += ["", f"TRA permutation control ({tp['n']} within-date label shuffles of the training windows, full TRA refit "
                    f"each): empirical p = {tp['p']:.3f} (smallest attainable {tp['min_attainable_p']:.3f}). The verdict's "
                    "development gates use TRA's IC t-stat and this p-value, because TRA is the model being judged."]
    elif ad.get("selected") == "tra":
        out += ["", "TRA permutation control was not run, so the permutation gate fails for the selected model."]
    return out


def _fund_md(da, fe, cfg):
    fa = da.get("fundamentals")
    if not fa:
        return []
    mc = fa.get("mapping_counts", {})
    L = ["## Fundamentals and sectors (SEC EDGAR)", "",
         f"- Source: {fa['source']}; {fa.get('requests', 0)} requests this run (cached responses reused).",
         f"- Ticker to filer (CIK) mapping for {len(fa['mapping'])} priced members: "
         + ", ".join(f"{k}: {v}" for k, v in mc.items()) + ".",
         f"- **Uncertain mappings (full-text search or name-matched predecessor CIK; filing period, current symbol and float checked): "
         f"{', '.join(fa['uncertain_mappings']) or 'none'}.**",
         f"- Unresolved (no filer found): {', '.join(fa['unresolved']) or 'none'}.",
         *([f"- Eligibility: {fa['eligibility']}; this removes {fa['member_days_dropped_no_fundamentals']:.1%} of priced member-days "
            "(before XBRL began and for unmapped names). The strategy and every baseline use the same reduced universe."]
           if fa.get("eligibility") else []),
         f"- Sectors (current SIC code grouped): {fa.get('sector_counts')}."]
    L += [f"- Rule: {r}." for r in fa.get("rules", [])]
    if fa.get("coverage_by_year"):
        L += ["", "| Year | Eligible member-days with fundamentals |", "|---|---:|"]
        L += [f"| {y} | {v:.0%} |" for y, v in fa["coverage_by_year"].items()]
        L += ["", "| Feature | Definition | Coverage of eligible member-days |", "|---|---|---:|"]
        L += [f"| {f} | {d} | {fa['feature_coverage'].get(f, 0):.0%} |" for f, d in fa.get("features", {}).items()]
    la = fe.get("lookahead_audit", {}).get("fundamental_sec")
    if la:
        L += ["", f"Look-ahead audit: all {la['companies']} mapped companies rebuilt at {', '.join(la['cut_dates'])} from filings "
                  f"available by then; {la['mismatches']} mismatches."]
    return L + [""]


def _qlib_md(cfg, fe, pf, ho):
    """Which Qlib component did each step, plus the independent simulator cross-check."""
    mode = fe.get("mode", "alpha158")
    feats = {"alpha158": "`qlib.contrib.data.handler.Alpha158`",
             "fundamental": "`DataHandlerLP` + `QlibDataLoader` on `$f_*` fields written into the run's Qlib provider",
             "both": "`Alpha158` and `DataHandlerLP` + `QlibDataLoader` on `$f_*` fields"}[mode]
    L = ["## Qlib components used", "",
         "| Step | Qlib component |", "|---|---|",
         "| Price storage and loading | Qlib binary provider, `qlib.data.D.features` |",
         f"| Universe | {'Qlib instruments market `' + str(fe.get('qlib_market', '')) + '` (one line per eligible spell)' if mode != 'alpha158' else 'instrument list of priced members; eligibility mask from point-in-time membership'} |",
         f"| Features and labels | {feats}; processors `ProcessInf` → `CSRankNorm`; labels are Qlib expressions `Ref($open,-h-1)/Ref($open,-1)-1` |",
         "| Sector-neutral labels | Qlib `Processor` subclass `SectorDemean` |" if _neutral(cfg) else "| Sector-neutral labels | not used |",
         "| Model | `qlib.contrib.model.gbdt.LGBModel` on `qlib.data.dataset.DatasetH` (`DropnaLabel` → `CSRankNorm(label)`); "
         "permutation control via a Qlib `Processor` that shuffles training labels within dates |",
         "| Regime-adaptive model (if run) | `qlib.contrib.model.pytorch_tra.TRAModel` on `MTSDatasetH` |",
         "| IC, feature screen, signal analysis | `qlib.contrib.eva.alpha.calc_ic`, `calc_all_ic`, `calc_long_short_return` (the `SigAnaRecord` metrics) |",
         "| Backtests (strategy and every baseline) | `qlib.backtest.backtest`, `SimulatorExecutor`, Qlib `Exchange` (fill at open, costs on traded value), "
         "strategy = `WeightStrategyBase` subclass with `OrderGenWOInteract` |",
         "| Performance and excess-return metrics | `qlib.contrib.evaluate.risk_analysis` (N = 252) |",
         "",
         "Not available in Qlib, so done by the engine's own tested code: purged walk-forward split dates, SEC "
         "point-in-time fundamentals, sector-balanced slot allocation, the non-overlapping IC t-statistic, permutation "
         "p-value, block-bootstrap Sharpe interval, calendar-year returns, verdict gates, and the sale of holdings whose "
         "prices end (Qlib cannot trade a stock after its last price)."]
    return L + [""]


def _md_table(df):
    head = "| Year | " + " | ".join(df.columns) + " |"
    sep = "|---|" + "---:|" * len(df.columns)
    body = ["| " + str(i) + " | " + " | ".join("" if pd.isna(v) else f"{v:+.1f}" for v in r) + " |" for i, r in df.iterrows()]
    return "\n".join([head, sep] + body)


def _f4(x):
    return "n/a" if x is None else f"{x:+.4f}"


def _pct(x):
    return "n/a" if x is None or (isinstance(x, float) and np.isnan(x)) else f"{x:+.1%}"


def phase_report(run, args):
    cfg = run.cfg
    R = {n: run.read(f) for n, f in [("env", "env.json"), ("uni", "universe.json"), ("da", "data_audit.json"),
                                     ("sp", "splits.json"), ("fe", "features.json"), ("fa", "factors.json"),
                                     ("mo", "model.json"), ("rb", "robustness.json"), ("ad", "advanced.json"),
                                     ("pf", "portfolio.json"), ("ov", "overlay.json"), ("ho", "holdout_results.json")]}
    dev = pd.read_pickle(run.p("results", "dev_navs.pkl"))
    hol = pd.read_pickle(run.p("results", "holdout_navs.pkl"))
    names = ["Strategy"] + [n for n in hol if n != "Strategy"]
    series = {n: _chain(dev[n]["nav"] / dev[n]["nav"].iloc[0] if n in dev else None, hol[n]["nav"] / hol[n]["nav"].iloc[0]) for n in names}
    h = R["fa"]["horizon"]
    Y = pd.read_pickle(run.p("data", "labels.pkl"))[f"LABEL{h}"]
    ic_dev = pd.Series(R["rb"]["ic_by_year"])
    ic_dev.index = ic_dev.index.astype(str)
    ic_all = pd.concat([ic_dev, pd.Series({"holdout": R["ho"]["ic"]["mean_ic"]})])
    attempts = len([a for a in json.loads(run.p("holdout_attempts.json").read_text()) if a.get("completed")])
    D_mem, D_ho = W.membership(R["uni"]), W.holdout(R["ho"], R["sp"], attempts)
    ann = _plots(run, series, pd.Timestamp(R["sp"]["holdout_start"]), ic_all, D_ho["chart_title"])
    conc = concentration(run)
    run.write("concentration.json", conc)
    ann.to_csv(run.p("results", "annual_returns.csv"))
    pd.DataFrame(series).to_csv(run.p("results", "nav_per_unit.csv"))
    # archive code
    cdir = run.p("code")
    cdir.mkdir(exist_ok=True)
    shas = {}
    for f in ["qs_pipeline.py", "qs_core.py", "qs_data.py", "qs_describe.py", "qs_membership.py", "qs_tra.py",
              "qs_fundamentals.py", "qs_qlib.py", "run.sh", "test_qs_core.py", "test_qs_data.py", "test_qs_fund.py",
              "test_qs_qlib.py", "VERSION"]:
        src = Path(_HERE) / f
        if src.exists():
            shutil.copy2(src, cdir / f)
            shas[f] = hashlib.sha256(src.read_bytes()).hexdigest()[:16]
    ho, pf, ov, rb, fa, mo, da, sp, uni = (R[k] for k in ["ho", "pf", "ov", "rb", "fa", "mo", "da", "sp", "uni"])
    L = []
    L += [f"# {cfg['name']} — systematic strategy research report", "",
          f"Generated {dt.datetime.now():%Y-%m-%d %H:%M} by the Helm qlib research engine v{VERSION} (config hash `{cfg['config_hash']}`; "
          f"research phases run by engine {cfg.get('engine', '?')}).", "",
          f"**Membership:** {D_mem['label']}. **Holdout:** {D_ho['status']}.", ""]
    if cfg["null_signal"]:
        L += ["> **SYNTHETIC NULL-SIGNAL TEST.** Features were shuffled across stocks within each date. "
              "Any 'signal' here is noise by construction; this run exists to test the skill, not the market.", ""]
    base_verdict = ho["verdict"].split("  [holdout period previously examined")[0]
    L += ["## Verdict", "", f"**{base_verdict}{D_ho['verdict_suffix']}**", ""]
    for r_ in ho.get("rescore_history", []):
        L += [f"> **Re-scored {r_['at'][:10]}:** {r_['reason']}. No model, parameter or construction choice changed; "
              f"the strategy's own numbers are unchanged. Verdict before re-scoring: {r_['previous']['verdict']}.", ""]
    if ho["failed"]:
        L += ["Gates not met:"] + [f"- {x}" for x in ho["failed"]] + [""]
    if ho["passed"]:
        L += ["Gates met:"] + [f"- {x}" for x in ho["passed"]] + [""]
    if D_ho["examined"]:
        prior = ho.get("previous_examinations", [])
        L += [f"> **Holdout status: previously examined.** {D_ho['limitation']}"
              + (f" Earlier evaluations: {'; '.join(_prior_md(r) for r in prior[:3])}" + (" …" if len(prior) > 3 else "") + "." if prior else ""), ""]
    s_d, s_h = Q.perf(dev["Strategy"]["nav"]), ho["strategy"]
    rows = [("Strategy (net)", s_d, s_h)] + [(n, pf["baselines"].get(n, {}), ho["baselines"].get(n, {})) for n in ho["baselines"]]
    L += ["## Headline numbers (net of costs)", "",
          f"Development = walk-forward test years {sp['folds'][0]['test'][0]} to {sp['folds'][-1]['test'][1]} "
          f"(out-of-sample per year, but construction choices were selected here). "
          f"{D_ho['headline']}", "",
          "| Series | Dev CAGR | Dev Sharpe | Dev MaxDD | Holdout CAGR | Holdout Sharpe | Holdout MaxDD |",
          "|---|---:|---:|---:|---:|---:|---:|"]
    for n, a, b in rows:
        L.append(f"| {n} | {_pct(a.get('cagr'))} | {a.get('sharpe', float('nan')):.2f} | {_pct(a.get('max_drawdown'))} | "
                 f"{_pct(b.get('cagr'))} | {b.get('sharpe', float('nan')):.2f} | {_pct(b.get('max_drawdown'))} |")
    L += [f"| Random top-K (Sharpe mean / 95th pct, n={cfg['n_random']}) | | {pf['random_sharpe']['mean']:.2f} / {pf['random_sharpe']['p95']:.2f} | | | "
          f"{ho['random_sharpe']['mean']:.2f} / {ho['random_sharpe']['p95']:.2f} | |", "",
          f"Holdout Sharpe 95% block-bootstrap CI: [{ho['sharpe_bootstrap_95ci']['lo']:.2f}, {ho['sharpe_bootstrap_95ci']['hi']:.2f}]. "
          f"Holdout excess vs equal-weight universe: {ho['excess_vs_ew']['ann_excess_arith']:+.2%}/yr (arithmetic), "
          f"information ratio {ho['excess_vs_ew']['information_ratio']:.2f}.", "",
          f"Holdout concentration ({conc['note']}, CAGR {_pct(conc['full_cagr'])} over {conc['rebalances']} rebalances) — "
          "leave-one-out on the most-held names: " + "; ".join(
              f"{n['ticker']} held {n['times_held']}x (name {_pct(n['name_total_return'])}) → CAGR without it {_pct(n['cagr_without'])}"
              for n in conc["names"]) + ".", "",
          f"Long-short diagnostic (top-K minus bottom-K, {pf.get('construction', 'top-K')}, costs on both legs, no borrow cost; "
          "not a gate): " + "; ".join(f"{lbl} CAGR {_pct(x.get('cagr'))}, Sharpe {x.get('sharpe', float('nan')):.2f}, t {x.get('t_stat', float('nan')):.2f}"
                                      for lbl, x in [("development", pf.get("long_short") or {}), ("holdout", ho.get("long_short") or {})]) + ".", "",
          "![NAV and drawdown](plots/nav_drawdown.png)", "", "![Annual returns](plots/annual_returns.png)", "",
          "## Annual returns (net, %)", "", _md_table(ann.round(1)), ""]
    cov = pd.DataFrame(da.get("coverage_by_year", []))
    if len(cov) and "year" not in cov:
        cov = cov.rename(columns={cov.columns[0]: "year"})
    L += ["## Universe, membership and data", "",
          f"- Membership: **{D_mem['label']}**. {D_mem['summary']} {uni['n']} names were members at some point "
          f"({uni.get('spells', uni['n'])} membership spells); {len(da['tickers_with_data'])} have usable prices.",
          f"- {D_mem['bias']}"] + [
          f"- Member-day price coverage: {da.get('member_day_coverage', float('nan')):.1%}. "
          f"Members never priced (excluded on their member days): "
          f"{', '.join(f'{t} ({sp_[0]}{chr(8230) if len(sp_) > 1 else chr(32)})' for t, sp_ in list(da.get('members_never_priced', {}).items())[:40]) or 'none'}"
          f"{' …' if len(da.get('members_never_priced', {})) > 40 else ''}.",
          f"- Partly priced members (share of member-days with prices): {da.get('members_partly_priced') or 'none'}.",
          f"- Ticker renames applied: {W.renames(da)}; Yahoo symbols rejected as a different company: "
          f"{da.get('yahoo_symbols_rejected') or 'none'}."] + W.corrections(da) + [""]
    if len(cov):
        L += ["| Year | Avg. members | Avg. members priced | Coverage |", "|---|---:|---:|---:|"]
        L += [f"| {int(r['year'])} | {r['members']:.0f} | {r['members_with_prices']:.0f} | {r['coverage']:.0%} |" for r in cov.to_dict("records")]
        L += [""]
    L += [
          f"- Benchmark ETF: {uni['benchmark_etf'] or 'none'} ({'available' if da['benchmark_available'] else 'NOT available'}). "
          "Equal-weight universe, momentum top-K and random top-K use identical rebalancing and costs.",
          f"- Data: {W.data_sources(da)}",
          ""]
    L += _fund_md(da, R["fe"], cfg)
    L += _qlib_md(cfg, R["fe"], pf, ho)
    L += ["## Experiment design (frozen before research)", "",
          f"- Signal at close t, fill at the next open; label = open(t+1+h)/open(t+1) − 1, identical to what the position earns.",
          f"- {sp['purge_note']}",
          f"- {len(sp['folds'])} yearly walk-forward folds (expanding train, 1-year purged validation for early stopping).",
          f"- Holdout {sp['holdout_start']}..{sp['end']}: final model trained on data whose labels end before it.", ""]
    L += ["## Factor and horizon research (first fold's training window only)", "",
          f"Window {fa['window'][0]}..{fa['window'][1]}. Factor counts by horizon: `{json.dumps(fa['counts_by_horizon'])}`. "
          f"Chosen horizon: **{h} trading days**{' (WEAK: no factor with |ICIR|>0.05)' if fa['weak_factor_signal'] else ''}. "
          f"Top-15 families: {fa['top15_families']}. Feature selection is repeated inside every fold on that fold's training data.", ""]
    L += ["## Model and robustness", "",
          f"- Features: {R['fe'].get('mode', 'alpha158')} ({R['fe']['n_features']} columns). IC is measured against "
          f"{'returns relative to the same-day sector average (sector-neutral)' if _neutral(cfg) else 'raw forward returns'}.",
          f"- LightGBM, {len(cfg['seeds'])} seeds averaged. Walk-forward rank IC {mo['walk_forward_ic']['mean_ic']:+.4f}, "
          f"ICIR {mo['walk_forward_ic']['icir']:.3f}, non-overlapping t-stat {mo['walk_forward_ic']['t_nonoverlap']:.2f}; "
          f"{rb['years_positive']}/{rb['years_total']} test years positive.",
          *([f"- Hyperparameter tuning (opt-in): {mo['tuning']['n_configs']} LightGBM configs, Latin-hypercube random search with successive halving, "
             f"scored only on purged validation years ({mo['tuning']['fits']} single-seed fits). "
             + (f"PBO (CSCV over {mo['tuning']['pbo']['blocks']} folds) = {mo['tuning']['pbo']['pbo']:.2f}. " if mo['tuning'].get('pbo') else "PBO not estimable. ")
             + f"{mo['tuning']['selection']['reason']} The permutation control refits with the chosen parameters but does not re-run the search, "
             "so it slightly understates how much tuning can find in noise."]
            if isinstance(mo.get("tuning"), dict) else []),
          *([f"- Linear baseline (ridge regression, L2 penalty chosen on each fold's validation year, same features and folds): "
             f"walk-forward rank IC {mo['ridge_baseline']['walk_forward_ic']['mean_ic']:+.4f}, t {mo['ridge_baseline']['walk_forward_ic']['t_nonoverlap']:.2f}. "
             f"LightGBM minus ridge: {mo['ridge_baseline']['lgb_minus_ridge']['mean_ic']:+.4f} per day (t {mo['ridge_baseline']['lgb_minus_ridge']['t_nonoverlap']:.2f}). "
             f"{mo['ridge_baseline']['reading']} (Diagnostic only: it does not change the model or any trial count.)"]
            if isinstance(mo.get("ridge_baseline"), dict) and "walk_forward_ic" in mo["ridge_baseline"] else []),
          f"- LightGBM permutation control ({len(rb['perm_ics'])} within-date label shuffles, full refit each): empirical p = {rb['perm_p']:.3f} "
          f"(smallest attainable {rb.get('min_attainable_p', float('nan')):.3f}), z = {rb['perm_z']:.2f} → {rb['verdict']}. "
          "The z-score assumes normal permutation ICs and is shown for scale only; the gate uses the empirical p.",
          f"- Regime (equal-weight universe up vs down calendar years): mean IC up {_f4(rb['regime']['up_years_mean_ic'])}, "
          f"down {_f4(rb['regime']['down_years_mean_ic'])} (down years: {rb['regime']['down_years'] or 'none'}).",
          f"- Seed sensitivity: mean per-fold IC range across seeds {rb['seed_ic_range_per_fold']:.4f}.",
          *[f"- Qlib signal analysis ({lbl}; `SigAnaRecord` metrics): " + ", ".join(
              f"{k_} {v_:+.4f}" if "IC" in k_ else f"{k_} {v_:+.2f}" for k_, v_ in x.items() if k_ != "source")
            + f". {x['source']}." for lbl, x in [("development", mo.get("signal_analysis")), ("holdout", ho.get("signal_analysis"))] if x],
          f"- Advanced models: {R['ad']['decision']}", ""] + _advanced_md(R["ad"]) + ["", "![IC by year](plots/ic_by_year.png)", "",
          "| Fold | Features | Best iterations | Test IC |", "|---|---:|---|---:|"]
    for fn, f in mo["folds"].items():
        L.append(f"| {fn} | {f['n_features']} | {f['best_iterations']} | {f['test_ic']['mean_ic']:+.4f} |")
    L += ["", "## Portfolio construction and costs", "",
          f"- Long-only {'sector-balanced top-K (each SIC sector gets slots in proportion to its share of eligible names; momentum and random baselines are built the same way)' if _neutral(cfg) else 'top-K'}, "
          f"equal weight at each rebalance, every {pf['rebalance_every_days']} trading days; "
          + ("momentum and random baselines are turnover-matched (same names per sector and same number replaced at each "
             "rebalance as the strategy); " if pf.get("baseline_construction", "").startswith("turnover") else "") +
          f"chosen topk={pf['chosen']['topk']}, n_drop={pf['chosen']['n_drop']} from {pf['n_trials']} variants (dev Sharpe).",
          f"- Costs: {cfg['cost_bps']} bps per side on traded notional; idle cash earns 0%; holdings drift between rebalances.",
          f"- Dev annual turnover {pf['strategy']['annual_turnover']:.1f}x equity; break-even cost vs equal-weight: {pf['breakeven_cost_bps_vs_ew']} bps/side.",
          f"- Risk overlay: {(ov.get('chosen_family', 'vol_target') + ' ' + json.dumps(ov['chosen'])) if ov['use_overlay'] else 'none kept'} "
          f"({ov['n_trials']} grid points; rule: {ov['rule']})."
          + ("" if not ov.get("families") else " By family: " + "; ".join(
              f"{f} best dSharpe {v['best_delta_sharpe']:+.2f} at {json.dumps(v['best_params'])}, "
              f"{v['fraction_improving']:.0%} of {v['n']} points improve{' (qualifies)' if v['qualifies'] else ''}"
              for f, v in ov["families"].items()) + "."), "",
          "| Cost (bps/side) | Dev CAGR | Dev Sharpe | Holdout CAGR | Holdout Sharpe |", "|---:|---:|---:|---:|---:|"]
    for b in pf["cost_sensitivity"]:
        d_, h_ = pf["cost_sensitivity"][b], ho["cost_sensitivity"][str(b)] if str(b) in ho["cost_sensitivity"] else ho["cost_sensitivity"][b]
        L.append(f"| {b} | {_pct(d_['strategy_cagr'])} | {d_['strategy_sharpe']:.2f} | {_pct(h_['cagr'])} | {h_['sharpe']:.2f} |")
    L += ["", "## Limitations", "",
          f"- {D_mem['limitation']}",
          "- Adjusted prices; fills at the adjusted open with a flat cost; no market impact, borrow, taxes or slippage model.",
          f"- Selection effects: {pf['n_trials']} construction variants and {ov['n_trials']} overlay settings were compared on the "
          "development period; development numbers are optimistic.",
          f"- {D_ho['limitation']}",
          "- Factor horizon chosen on the earliest training window only; later regimes may favour another horizon.",
          ("- Yahoo-built providers have no true VWAP (a typical-price proxy is stored) — VWAP-based Alpha158 columns are approximate."
           if R["fe"].get("mode", "alpha158") != "fundamental" else "- Price data from Yahoo/shared Qlib (see data notes above).")
          if da["decision"].startswith("yahoo") else "- Shared Qlib data may stop before today; see data notes above.",
          *(["- Fundamentals: XBRL starts 2009-2011, so research starts later than price-only runs; filing time of day is unknown "
             "(values used from the next day); market value uses the cover-page public float (excludes insiders) rolled forward "
             "with total-return prices; some delisted members could not be mapped to a filer, so fundamental coverage is "
             "lower for names that later left the index (see the coverage table)."] if _uses_fund(cfg) else []),
          *(["- Sectors use each company's current SEC SIC code, not a historical classification."] if _neutral(cfg) else []),
          "- A negative verdict is a valid result: it means this universe/feature set/model did not show a reliable edge here.", ""]
    L += ["## Reproducibility", "", f"- Python {R['env']['python_version']} at `{R['env']['python']}`; packages {json.dumps(R['env']['packages'])}.",
          f"- Code archived in `code/` (sha256 prefixes {json.dumps(shas)}).", f"- Re-run / resume: `{cfg['command']}`",
          "- Every grid trial is in `experiment_log.jsonl`; all intermediate outputs are in this folder.", ""]
    text = "\n".join(L)
    bad = W.contradictions(text, uni, D_ho)
    if bad:
        raise RuntimeError("report contradicts run metadata:\n" + "\n".join(bad))
    C.atomic_write_text(run.p("report.md"), text)
    log(f"report: {run.p('report.md')}")


# ---------------------------------------------------------------------------
# Re-score a finished run (baselines and verdict only)
# ---------------------------------------------------------------------------

RESCORE_REASON = ("momentum and random baselines are now turnover-matched: they hold as many names per sector as the "
                  "strategy and replace as many at each rebalance (before, they re-drew every name at every rebalance, "
                  "so at short horizons they paid far more trading cost than the strategy)")


def rescore(run, args):
    """Recompute the momentum and random baselines and the verdict of a finished run from its saved
    predictions and frozen choices (horizon, model, K, n_drop, overlay). Nothing is refitted or
    re-selected; the strategy's own numbers do not change. Logged in holdout_attempts.json."""
    if not (run.done("holdout") and run.p("holdout_results.json").exists()):
        raise RuntimeError("rescore needs a run whose holdout phase is complete")
    cfg, sp, fa, pf = run.cfg, run.read("splits.json"), run.read("factors.json"), run.read("portfolio.json")
    h, k, nd = fa["horizon"], pf["chosen"]["topk"], pf["chosen"]["n_drop"]
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    opens, closes = px["open"], px["close"]
    now = dt.datetime.now().isoformat(timespec="seconds")

    def suite(pred, a, b):
        scores = _score_matrix(pred)
        sig = [d for d in C.rebalance_dates(closes.index, a, b, h) if d < b]
        return baseline_suite(run, opens, closes, sig, k, nd, cfg["cost_bps"], a, b, cfg["n_random"], h,
                              _targets(run, scores, sig, k, nd))

    a, b = pd.Timestamp(sp["folds"][0]["test"][0]), pd.Timestamp(sp["folds"][-1]["test"][1])
    base, rnd = suite(pd.read_pickle(run.p("results", "pred_dev_selected.pkl")), a, b)
    pf.setdefault("rescore_history", []).append({"at": now, "reason": RESCORE_REASON,
                                                 "previous": {"baselines": pf["baselines"], "random_sharpe": pf["random_sharpe"]}})
    pf["baselines"] = {n_: Q.sim_stats(s_) for n_, s_ in base.items()}
    pf["random_sharpe"] = {"mean": float(rnd.mean()), "p05": float(np.percentile(rnd, 5)),
                           "p95": float(np.percentile(rnd, 95)), "n": int(len(rnd))}
    pf["baseline_construction"] = "turnover-matched (qs_core.matched_targets)"
    run.write("portfolio.json", pf)
    navs = pd.read_pickle(run.p("results", "dev_navs.pkl"))
    navs.update(base)
    C.atomic_pickle(run.p("results", "dev_navs.pkl"), navs)

    ho = run.read("holdout_results.json")
    a, b = pd.Timestamp(sp["holdout_start"]), pd.Timestamp(sp["end"])
    base_h, rnd_h = suite(pd.read_pickle(run.p("results", "pred_holdout.pkl")), a, b)
    ho.setdefault("rescore_history", []).append({"at": now, "reason": RESCORE_REASON, "previous": {
        k_: ho[k_] for k_ in ("verdict", "failed", "passed", "baselines", "random_sharpe", "gates_dev", "gates_holdout")}})
    ho["baselines"] = {n_: Q.sim_stats(s_) for n_, s_ in base_h.items()}
    ho["random_sharpe"] = {"mean": float(rnd_h.mean()), "p95": float(np.percentile(rnd_h, 95))}
    dev = {**ho["gates_dev"], "momentum_sharpe": pf["baselines"]["Momentum top-K"]["sharpe"],
           "random_p95_sharpe": pf["random_sharpe"]["p95"], "ew_sharpe": pf["baselines"]["Equal-weight universe"]["sharpe"]}
    hold = {**ho["gates_holdout"], "random_p95_sharpe": ho["random_sharpe"]["p95"]}
    v = C.verdict(dev, hold)
    if cfg["null_signal"]:
        v["verdict"] += "  [SYNTHETIC NULL-SIGNAL TEST RUN]"
    if ho.get("previous_examinations"):
        v["verdict"] += "  [holdout period previously examined — not an untouched test]"
    ho.update({"gates_dev": dev, "gates_holdout": hold, **v})
    run.write("holdout_results.json", ho)
    hn = pd.read_pickle(run.p("results", "holdout_navs.pkl"))
    hn.update(base_h)
    C.atomic_pickle(run.p("results", "holdout_navs.pkl"), hn)
    lock = run.p("holdout_attempts.json")
    att = json.loads(lock.read_text())
    att.append({"at": now, "kind": "rescore", "completed": False,
                "note": "baselines and verdict recomputed from saved predictions; no refit, no re-selection"})
    C.atomic_write_json(lock, att)
    log(f"rescore: dev momentum Sharpe {dev['momentum_sharpe']:.2f}, random p95 {dev['random_p95_sharpe']:.2f}; "
        f"holdout random p95 {hold['random_p95_sharpe']:.2f}")
    log(f"VERDICT (re-scored): {v['verdict']}  (was: {ho['rescore_history'][-1]['previous']['verdict']})")
    phase_report(run, args)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Idea test (--idea-file): user factors on the point-in-time universe, development period only
# ---------------------------------------------------------------------------

def _clean(o):
    """JSON-safe: NaN/inf -> None (Node's JSON.parse rejects NaN), numpy scalars -> Python."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, pd.Timestamp):
        return str(o.date())
    return o


def _expr_audit(exprs, cols, start, cut, full: dict):
    """Look-ahead audit for price expressions: recomputed with data ending at `cut`, the values on
    `cut` must equal those computed with the whole development period."""
    worst = 0.0
    for e in exprs:
        part = IDEA.qlib_expr_wide(e, cols, start, cut)
        d = part.index.max()
        a, b = part.loc[d], full[e].reindex(columns=part.columns).loc[d]
        m = a.notna() & b.notna()
        diff = float(np.nanmax(np.abs(a[m].values - b[m].values))) if m.any() else 0.0
        if not diff < 1e-6 * max(1.0, float(np.nanmax(np.abs(b[m].values))) if m.any() else 1.0):
            raise RuntimeError(f"Look-ahead audit failed for idea expression {e}: values at {d.date()} change "
                               f"when later data is added (max abs diff {diff:.3g}).")
        worst = max(worst, diff)
    return {"cut_date": str(pd.Timestamp(cut).date()), "expressions": len(exprs), "max_abs_diff": worst}


def _idea_plots(run, name, res):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                         "axes.edgecolor": "#8a8984", "axes.grid": True, "grid.color": "#e6e5e0",
                         "grid.linewidth": 0.6, "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb"})
    pdir = run.p("plots")
    pdir.mkdir(exist_ok=True)
    h, ic = res["best_horizon"], res["_ic_series"]
    files = []
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 5.5), gridspec_kw={"height_ratios": [1, 1.2]})
    yr = pd.Series(res["by_year_ic"], dtype=float)
    a1.bar(yr.index.astype(str), yr.values, color=["#2a78d6" if v > 0 else "#e34948" for v in yr.values])
    a1.axhline(0, color="#52514e", lw=0.8)
    a1.set_title(f"{name}: mean daily rank IC by year ({h}-day forward return, development period only)", loc="left")
    a2.plot(ic.index, ic.cumsum().values, color="#2a78d6", lw=1.5)
    a2.axhline(0, color="#52514e", lw=0.8)
    a2.set_ylabel("Cumulative daily IC")
    fig.tight_layout()
    fn = f"idea_ic_{name}.png"
    fig.savefig(pdir / fn, dpi=150)
    plt.close(fig)
    files.append(fn)
    q = res["quantiles"]
    vals = [np.nan if v is None else v * 100 for v in q["annual_returns"]]
    fig, ax = plt.subplots(figsize=(7, 3.6))
    ax.bar([f"Q{i}" for i in range(1, len(vals) + 1)], vals, color=["#8a8984"] * (len(vals) - 1) + ["#2a78d6"])
    ax.axhline(0, color="#52514e", lw=0.8)
    ls, net = q.get("long_short_annual"), q.get("long_short_net_annual")
    sub = "" if ls is None else f"; Q5-Q1 {ls * 100:+.1f}%/yr gross, {net * 100:+.1f}%/yr net of costs"
    ax.set_title(f"{name}: {h}-day forward return by score quintile (annualised{sub})", loc="left", fontsize=8.5)
    ax.set_ylabel("% per year (arithmetic)")
    fig.tight_layout()
    fn = f"idea_quantiles_{name}.png"
    fig.savefig(pdir / fn, dpi=150)
    plt.close(fig)
    files.append(fn)
    return files


def _fmt(x, f="{:+.4f}"):
    return "—" if x is None else f.format(x)


def _idea_report(run, out, uni, t_crit, m_tests):
    L = [f"# 想法检验：{out['idea']}", "",
         f"- 股票池：{out['universe']}（{uni.get('membership_kind')}，{uni.get('source')}）",
         f"- 开发期：{out['dev_window'][0]} 到 {out['dev_window'][1]}（只用这一段的数据）",
         f"- 验证期：{out['holdout_window'][0]} 到 {out['holdout_window'][1]}，**这次没有读取，也没有用到**",
         f"- 检验的持有天数：{', '.join(str(h) for h in out['horizons'])} 个交易日；交易成本 {out['cost_bps']:g} bp（单边）",
         f"- 多重检验：这个想法 {out['trials']['this_idea']} 个因子；这个股票池上累计检验过 {out['trials']['universe_total']} 个不同的因子，"
         f"共 {m_tests} 次检验（因子 × 持有天数）→ t 值门槛 **{t_crit:.2f}**", "",
         "## 结论", "", out["summary_zh"], "",
         "| 因子 | 结论 | 最佳持有天数 | 平均 IC | t (NW) | IC 为正的年份 | 多空/年（扣成本） | 覆盖率 |",
         "|---|---|---|---|---|---|---|---|"]
    for f in out["factors"]:
        s = f["ic"][str(f["best_horizon"])]
        q = f["quantiles"]
        L.append(f"| {f['label']}（{f['name']}） | **{f['verdict_zh']}** | {f['best_horizon']} 天 | {_fmt(s['mean'])} | "
                 f"{_fmt(s['t'], '{:.2f}')} | {_fmt(f['share_years_positive'], '{:.0%}')} | "
                 f"{_fmt(q.get('long_short_net_annual'), '{:+.1%}')} | {_fmt(f['coverage'], '{:.0%}')} |")
    for f in out["factors"]:
        L += ["", f"## {f['label']}（{f['name']}）：{f['verdict_zh']}", "", "定义（每个部分先在当天的成分股里排名，再按权重相加，再排名；分数越高越买）："]
        for c in f["components"]:
            what = f"`{c['expr']}`" if "expr" in c else f"基本面 `{c['fundamental']}`（{IDEA.fund_features().get(c['fundamental'], '')}）"
            L.append(f"- {what}，权重 {c['weight']:g}" + ("（越低越好）" if c["weight"] < 0 else ""))
        L += ["", "| 持有天数 | 平均 IC | ICIR（日） | t（Newey-West） | t（不重叠抽样） | IC>0 的天数占比 | 天数 |", "|---|---|---|---|---|---|---|"]
        for h in out["horizons"]:
            s = f["ic"][str(h)]
            L.append(f"| {h} | {_fmt(s['mean'])} | {_fmt(s['ir'], '{:.3f}')} | {_fmt(s['t'], '{:.2f}')} | "
                     f"{_fmt(s['t_nonoverlap'], '{:.2f}')} | {_fmt(s['pos_share'], '{:.0%}')} | {s['days']} |")
        q = f["quantiles"]
        L += ["", f"按分数分五组（{q['horizon']} 天远期收益，算术年化）：" +
              " / ".join(f"Q{i + 1} {_fmt(v, '{:+.1%}')}" for i, v in enumerate(q["annual_returns"])) +
              f"；最高组减最低组 {_fmt(q.get('long_short_annual'), '{:+.1%}')}/年，扣成本 {_fmt(q.get('long_short_net_annual'), '{:+.1%}')}/年"
              f"（每 {q['horizon']} 天换仓，最高组每次换掉 {_fmt(f['turnover_top_quintile'], '{:.0%}')}）；"
              + ("五组单调递增。" if q.get("monotonic") else "五组不是单调的。"),
              "", "分年 IC：" + "，".join(f"{y} {v:+.3f}" for y, v in f["by_year_ic"].items()),
              "", "和已知因子的相关（每日截面 Spearman 平均）：" +
              "，".join(f"{IDEA.KNOWN_ZH.get(k, k)} {_fmt(v, '{:+.2f}')}" for k, v in f["corr_known"].items()),
              "", "判定理由：", ""] + [f"- {r}" for r in f["reasons_zh"]]
        L += ["", f"![IC](plots/idea_ic_{f['name']}.png)", "", f"![分组](plots/idea_quantiles_{f['name']}.png)"]
    L += ["", "## 判定规则（事先定好的门槛）", "",
          "- 只用开发期：分数用到开发期最后一天为止的数据算；远期收益（第 t+1 天开盘到第 t+1+h 天开盘）必须在验证期开始前全部实现。验证期的价格一个都不读。",
          f"- 分组收益：每天先把远期收益截尾到当天中位数 ± {IDEA.CLIP_MAD:g} 倍 MAD（防止个别损坏的价格点主导平均数）；IC 用排名，不需要截尾。",
          f"- IC = 每天在当时的成分股（在指数里且有价格）里算分数和 h 天远期收益的 Spearman 相关；t 值用 Newey-West 标准误（滞后 max(2h, 10) 天，因为远期收益互相重叠）。",
          f"- 多重检验：Bonferroni 校正，门槛 t ≥ max(2.0, z(1 − 0.05 / (2M)))，M = 这个股票池上累计检验过的“因子 × 持有天数”数（登记表 `{out['trials']['registry']}`，按因子定义去重）。这次 M = {m_tests}，门槛 {t_crit:.2f}。",
          "- 最佳持有天数取 t 最大的那个；选择持有天数这一步也算进了 M。",
          f"- **有信号**：最佳持有天数的平均 IC > 0 且 t ≥ 门槛；IC 为正的年份 ≥ {IDEA.SIGN_SHARE:.0%}（只算有 ≥ {IDEA.YEAR_MIN_DAYS} 个交易日的年份）；"
          f"最高组减最低组扣成本后 > 0（成本 = 两条腿每次换掉的比例 × 2 × 单边成本 × 每年换仓次数）；有效天数 ≥ {IDEA.MIN_DAYS}；覆盖率 ≥ {IDEA.MIN_COVERAGE:.0%}。",
          f"- 和任何一个已知因子（12-1 动量、1 个月反转、60 日波动率、成交额规模、盈利收益率 E/P）的相关系数绝对值 > {IDEA.DUP_CORR}：视为这个已知因子换了个说法，结论最多“信号弱”。",
          f"- **信号弱**：没有全部满足上面的条件，但平均 IC > 0 且 t ≥ {IDEA.T_FLOOR}（不校正多重检验）；或者满足了但是已知因子的翻版。",
          "- **没有信号**：其余情况。方向是事先定的：分数越高越买；显著为负也算“没有信号”（反过来用要当作新想法重新检验）。",
          "", "## 数据说明", "",
          f"- {uni.get('survivorship_note', '')}",
          *([f"- 数据质量：开发期里有 {out['data_quality']['count']} 个“在指数里”的股票-交易日单日涨跌超过 +100% 或 -80%（"
             f"{'、'.join(out['data_quality']['tickers'])}），几乎都是损坏或对应错的价格序列。"]
            if (out.get("data_quality") or {}).get("count") else []),
          "- 价格是复权价；`$vwap` 是 (最高+最低+收盘)/3 的近似值，不是真实成交均价。",
          *(["- `$mkt` 是这个股票池自己的等权市场收益：每天取当天是成分股、且当天和前一天都有收盘价的股票，"
              f"日收益 close_t/close_(t-1)−1 的等权平均（少于 {IDEA.MARKET_MIN_NAMES} 只的日子为空）。只用当天和前一天的数据，"
              "成分按当天的历史成分；它不是 SPY，也不是市值加权。"]
            if IDEA.uses_market({"factors": out["factors"]}) else []),
          *(["- 基本面来自 SEC XBRL，财报提交日的下一个交易日起才可用，只用每期最早的一次申报（见 qs_fundamentals.py）；"
             "有基本面组成部分的因子，在缺基本面的成分股-交易日上没有分数（覆盖率见上表）。"]
            if any("fundamental" in c for f in out["factors"] for c in f["components"]) else []),
          "- 这是开发期结论，不是样本外结论。验证期留给之后的 LEAN 回测检验。"]
    C.atomic_write_text(run.p("idea_report.md"), "\n".join(L) + "\n")


def phase_idea(run, args):
    cfg, da, sp, uni = run.cfg, run.read("data_audit.json"), run.read("splits.json"), run.read("universe.json")
    stored = cfg.get("idea")
    if not stored:
        raise RuntimeError("no idea in config.json (run with --idea-file)")
    spec = IDEA.validate_idea({"idea": stored["idea"], "horizons": stored["horizons"],
                               "factors": [{k: f[k] for k in ("name", "label", "components")} for f in stored["factors"]]})
    hz = spec["horizons"]
    _qinit(run)
    px = pd.read_pickle(run.p("data", "prices.pkl"))
    cal = px["close"].index
    hs = pd.Timestamp(sp["holdout_start"])
    dev_cal = cal[cal < hs]
    dev_end, fstart = dev_cal[-1], pd.Timestamp(sp["feature_start"])
    cols = [t for t in da["tickers_with_data"] if t in px["open"].columns]
    el = pd.read_pickle(run.p("data", "eligible.pkl")).reindex(index=dev_cal, columns=cols).fillna(False).astype(bool)
    el_dev = el.loc[fstart:dev_end]
    opens_dev = px["open"][cols].loc[:dev_end]  # nothing from the holdout period is read below
    rets = {h: IDEA.fwd_returns(opens_dev, h).loc[fstart:dev_end].where(el_dev) for h in hz}
    fund = None
    if run.p("data", "fundamentals.pkl").exists():
        fund = {k: v.loc[:dev_end] for k, v in pd.read_pickle(run.p("data", "fundamentals.pkl")).items()}
    log(f"idea: {len(spec['factors'])} factor(s) x horizons {hz} on {len(cols)} names; development period "
        f"{fstart.date()}..{dev_end.date()} (holdout from {hs.date()} not read)")
    # every distinct expression once (user components + known factors), development period only
    exprs = sorted({c["expr"] for f in spec["factors"] for c in f["components"] if "expr" in c} | set(IDEA.KNOWN_FACTORS.values()))
    wide = {e: IDEA.qlib_expr_wide(e, cols, cfg["start"], dev_end).reindex(index=dev_cal, columns=cols) for e in exprs}
    cut = pd.Timestamp(sp["folds"][len(sp["folds"]) // 2]["test"][0])
    user_exprs = sorted({c["expr"] for f in spec["factors"] for c in f["components"] if "expr" in c})
    audit = {"expressions": _expr_audit(user_exprs, cols, cfg["start"], cal[cal <= cut][-1], wide) if user_exprs else None}
    if IDEA.uses_fundamentals(spec):
        audit["fundamental_sec"] = _fund_audit(run, cut)
    known = {k: wide[e].loc[fstart:dev_end].where(el_dev) for k, e in IDEA.KNOWN_FACTORS.items()}
    for k, f in IDEA.KNOWN_FUND.items():
        known[k] = fund[f].reindex(index=dev_cal, columns=cols).loc[fstart:dev_end].where(el_dev) if fund and f in fund else None
    # multiple testing: register this idea's factors on the universe first, then count
    ukey = _registry_key(cfg)
    dev_window = [str(fstart.date()), str(dev_end.date())]
    reg = IDEA.registry_path()
    IDEA.registry_add(reg, ukey, dev_window, spec["factors"], hz, extra={"run_dir": str(run.dir), "idea": spec["idea"][:200]})
    tr = IDEA.registry_trials(reg, ukey)
    m_tests = max(tr["tests"], len(spec["factors"]) * len(hz))
    t_crit = IDEA.t_threshold(m_tests)
    dq = IDEA.extreme_moves(opens_dev.loc[fstart:], el_dev)
    if dq["count"]:
        log(f"idea: data quality: {dq['count']} implausible one-day moves among eligible name-days "
            f"(e.g. {', '.join(dq['tickers'][:5])}); quintile returns are clipped per day, rank IC is unaffected")
    results, plots = [], []
    for i, fac in enumerate(spec["factors"]):
        parts = []
        for c in fac["components"]:
            raw = wide[c["expr"]] if "expr" in c else fund[c["fundamental"]].reindex(index=dev_cal, columns=cols).astype("float64")
            parts.append((raw.loc[fstart:dev_end], c["weight"]))
        score = IDEA.combine_components(parts, el_dev)
        res = IDEA.evaluate_factor(score, rets, known, cfg["cost_bps"], el_dev)
        if i == 0:  # cross-check the vectorised IC against a groupby Spearman (qlib calc_ic's method)
            h0 = res["best_horizon"]
            s_, r_ = score.stack(), rets[h0].stack()
            q_ic = QM.rank_ic_check(s_, r_)
            res["qlib_calc_ic_check"] = {"horizon": h0, "qlib_mean_ic": float(q_ic.mean()),
                                         "engine_mean_ic": res["ic"][str(h0)]["mean"],
                                         "abs_diff": abs(float(q_ic.mean()) - (res["ic"][str(h0)]["mean"] or 0))}
            if res["qlib_calc_ic_check"]["abs_diff"] > 1e-6:
                raise RuntimeError(f"IC cross-check against qlib calc_ic failed: {res['qlib_calc_ic_check']}")
        v = IDEA.judge(res, t_crit)
        files = _idea_plots(run, fac["name"], res)
        plots += files
        res.pop("_ic_series")
        results.append({"name": fac["name"], "label": fac["label"], "components": fac["components"], "hash": fac["hash"],
                        **res, **v})
        s = res["ic"][str(res["best_horizon"])]
        log(f"  {fac['name']}: {v['verdict']} | best {res['best_horizon']}d IC {_fmt(s['mean'])} t {_fmt(s['t'], '{:.2f}')} "
            f"(threshold {t_crit:.2f}) | years+ {_fmt(res['share_years_positive'], '{:.0%}')} | "
            f"L/S net {_fmt(res['quantiles'].get('long_short_net_annual'), '{:+.1%}')} | coverage {_fmt(res['coverage'], '{:.0%}')}")
    out = {"idea": spec["idea"], "universe": ukey, "target": cfg["target"], "membership_kind": uni.get("membership_kind"),
           "dev_window": dev_window, "holdout_window": [sp["holdout_start"], sp["end"]], "horizons": hz,
           "cost_bps": cfg["cost_bps"], "factors": results,
           "trials": {"this_idea": len(spec["factors"]), "universe_total": tr["factors"], "tests_total": m_tests,
                      "t_threshold": t_crit, "registry": str(reg),
                      "method": "Bonferroni, two-sided alpha 0.05 over M = factors x horizons ever tested on this universe; floor t >= 2"},
           "summary_zh": IDEA.summary_zh(results) + (
               f"（注意：开发期数据里有 {dq['count']} 个单日涨跌超过 +100%/-80% 的异常价格点，比如 {'、'.join(dq['tickers'][:3])}；"
               "分组收益已按天截尾，IC 用排名，不受影响。）" if dq["count"] else ""),
           "data_quality": dq, "plots": plots, "lookahead_audit": audit,
           "n_names": len(cols), "engine_version": VERSION,
           "notes": ["development period only; holdout-period prices are never read in this phase",
                     "$vwap is a (high+low+close)/3 proxy"]}
    out = _clean(out)
    run.write("idea.json", out)
    _idea_report(run, out, uni, t_crit, m_tests)
    log(f"idea: {out['summary_zh']}")


RUNNERS = {"env": phase_env, "universe": phase_universe, "data": phase_data, "design": phase_design,
           "features": phase_features, "factors": phase_factors, "model": phase_model,
           "robustness": phase_robustness, "advanced": phase_advanced, "portfolio": phase_portfolio,
           "overlay": phase_overlay, "holdout": phase_holdout, "report": phase_report, "idea": phase_idea}


def run_dir_for(args):
    name = args.name or (("CUSTOM_" + hashlib.sha1(args.tickers.encode()).hexdigest()[:6]) if args.target.lower() == "custom"
                         else args.target.upper())
    if args.null_signal and not args.name:
        name += "_NULLTEST"
    rid = f"_{args.run_id}" if args.run_id else ""
    return name, Path(args.workdir).expanduser().resolve() / "quant_runs" / f"{name}{rid}"


def _resume_command():
    out, skip = [], False
    for a in sys.argv[1:]:
        if skip:
            skip = False
            continue
        if a == "--stop-after":
            skip = True
            continue
        if a == "--force-holdout":
            continue
        out.append(f'"{a}"' if " " in a else a)
    return " ".join([os.path.join(_HERE, "run.sh")] + out)


def make_cfg(args, name):
    t = args.target.upper()
    if args.benchmark is not None:
        bench = args.benchmark.upper() or None
    elif t == "CUSTOM":
        bench = None
    else:
        key = ALIASES.get(t.lower(), t.lower()).upper()
        bench = BENCH_ALIAS.get(key, key)
    return {"engine": ENGINE, "membership_file": args.membership_file, "advanced": args.advanced,
            "name": name, "target": args.target, "tickers": args.tickers, "benchmark": bench,
            "start": args.start, "holdout_years": args.holdout_years, "min_train_years": args.min_train_years,
            "cost_bps": args.cost_bps, "seeds": [0, 1, 2][: args.n_seeds], "n_perm": args.n_perm,
            "n_perm_tra": args.n_perm_tra, "n_random": args.n_random, "tune_trials": max(0, min(int(args.tune or 0), C.TUNE_MAX_TRIALS)), "null_signal": args.null_signal, "data_source": args.data_source,
            "horizon": args.horizon, "features": args.features, "neutralize": args.neutralize,
            "idea": getattr(args, "idea", None),
            "idea_hash": IDEA.idea_hash(args.idea) if getattr(args, "idea", None) else None,
            "command": _resume_command(), "created": dt.datetime.now().isoformat(timespec="seconds")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run", "status", "tra-job", "rescore"])
    ap.add_argument("--target", help="QQQ, SOX, DIA, semiconductors, ... or 'custom' with --tickers")
    ap.add_argument("--membership-file", default=None,
                    help="historical membership: lines TICKER<TAB>start<TAB>end (point-in-time universe)")
    ap.add_argument("--advanced", choices=["auto", "tra", "off"], default="auto",
                    help="auto: run the Qlib TRA comparison only when robustness flags it; tra: always; off: never")
    ap.add_argument("--run-dir", help=argparse.SUPPRESS)
    ap.add_argument("--kind", help=argparse.SUPPRESS)
    ap.add_argument("--seed", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--folds", help=argparse.SUPPRESS)
    ap.add_argument("--tickers", default=None, help="comma-separated constituents (overrides instrument files)")
    ap.add_argument("--benchmark", default=None, help="benchmark ETF ticker ('' for none)")
    ap.add_argument("--name", default=None)
    ap.add_argument("--run-id", default=None, help="suffix for a separate run folder")
    ap.add_argument("--workdir", default=".")
    ap.add_argument("--start", default="2008-01-01")
    ap.add_argument("--holdout-years", type=float, default=2.0)
    ap.add_argument("--min-train-years", type=int, default=5)
    ap.add_argument("--cost-bps", type=float, default=10.0, help="one-way cost per traded dollar")
    ap.add_argument("--n-seeds", type=int, default=3)
    ap.add_argument("--n-perm", type=int, default=40, help=">= 19 needed for p < 0.05 to be reachable")
    ap.add_argument("--n-perm-tra", type=int, default=20,
                    help="TRA permutation refits, run only if TRA is selected (>= 20 for p < 0.05; 0 = skip, gate fails)")
    ap.add_argument("--n-random", type=int, default=100)
    ap.add_argument("--tune", type=int, default=0, help="opt-in LightGBM hyperparameter tuning: number of configs (0 = off, max 30)")
    ap.add_argument("--data-source", choices=["auto", "qlib", "yahoo"], default="auto")
    ap.add_argument("--max-stale-days", type=int, default=45)
    ap.add_argument("--null-signal", action="store_true", help="TEST ONLY: shuffle features to verify a negative verdict")
    ap.add_argument("--horizon", type=int, choices=HORIZONS, default=None,
                    help="override auto-selected horizon (trading days)")
    ap.add_argument("--features", choices=["alpha158", "fundamental", "both"], default="alpha158",
                    help="alpha158: Qlib price/volume factors; fundamental: point-in-time SEC XBRL factors; both")
    ap.add_argument("--neutralize", choices=["none", "sector"], default="none",
                    help="sector: labels/IC within SIC sectors and sector-balanced top-K portfolios")
    ap.add_argument("--stop-after", choices=ALL_PHASES, default=None)
    ap.add_argument("--idea-file", default=None,
                    help="idea test: JSON with user factors; runs env/universe/data/design then `idea`, then stops "
                         "(development period only; never model/holdout/report)")
    ap.add_argument("--force-holdout", action="store_true")
    args = ap.parse_args()
    if args.cmd == "tra-job":
        tra_job(args.run_dir, args.kind, args.seed, args.folds)
        return 0
    if not args.target:
        ap.error("--target is required")
    if args.membership_file:
        args.membership_file = os.path.abspath(os.path.expanduser(args.membership_file))
    name, rdir = run_dir_for(args)
    run = Run(rdir, IDEA_PHASES if args.idea_file else None)
    args.idea = None
    if args.idea_file and args.cmd == "run":
        try:
            raw = json.loads(Path(args.idea_file).expanduser().read_text(encoding="utf-8"))
            args.idea = IDEA.validate_idea(raw)
        except (IDEA.IdeaError, OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
            msg = (f"想法输入有误：{e}" if isinstance(e, IDEA.IdeaError) else
                   f"想法文件不是合法的 JSON：{e}" if isinstance(e, json.JSONDecodeError) else
                   f"读不到想法文件 {args.idea_file}：{e}")
            if not run.done("idea"):
                run.set("idea", "failed", error=msg)
            log(f"FAILED in idea: {msg}")
            return 2
    phases = IDEA_PHASES if (run.cfg or {}).get("idea") or args.idea_file else PHASES
    if args.cmd == "status":
        print(f"run dir: {rdir}")
        for p in phases:
            print(f"  {p:<11s} {run.status.get(p, {}).get('status', 'pending'):<9s} {run.status.get(p, {}).get('at', '')}")
        if run.p("holdout_results.json").exists():
            print("verdict:", run.read("holdout_results.json")["verdict"])
        return 0
    if args.cmd == "rescore":
        if run.cfg is None:
            print(f"No run at {rdir}", file=sys.stderr)
            return 2
        _qinit(run, qlib=True)
        rescore(run, args)
        return 0
    cfg = make_cfg(args, name)
    if run.cfg is None:
        run.cfg = cfg
        C.atomic_write_json(run.p("config.json"), cfg)
    else:
        diff = {k: (run.cfg.get(k, FROZEN_DEFAULTS.get(k)), cfg[k]) for k in FROZEN_KEYS
                if run.cfg.get(k, FROZEN_DEFAULTS.get(k)) != cfg[k]}
        if diff and not run.cfg.get("splits_frozen_at"):
            # Nothing is frozen until the design phase: accept corrected options (e.g. --tickers
            # after "No constituent list") and redo the phases that depend on them.
            log(f"options changed before the design was frozen ({sorted(diff)}); updating config and "
                "restarting from the universe phase")
            run.cfg = cfg
            C.atomic_write_json(run.p("config.json"), cfg)
            for p in phases[phases.index("universe"):]:
                run.status[p] = {"status": "pending"}
            run.save_status()
            diff = {}
        if diff:
            print(f"Refusing to resume {rdir}: options differ from the frozen config: {diff}\n"
                  f"Re-run with the original options, or use --run-id NEW for a separate run.", file=sys.stderr)
            return 2
        log(f"resuming {rdir}")
    if args.stop_after and args.stop_after not in phases:
        print(f"--stop-after {args.stop_after} is not a phase of this run ({', '.join(phases)})", file=sys.stderr)
        return 2
    for p in phases:
        if run.done(p) and not (p == "holdout" and args.force_holdout):
            log(f"= {p}: already complete, reusing outputs")
        else:
            log(f"> {p}")
            run.set(p, "running")
            t0 = time.time()
            try:
                if p != "data":
                    _qinit(run, qlib=p not in IDEA_PHASES)
                RUNNERS[p](run, args)
            except Exception as e:  # noqa: BLE001
                run.set(p, "failed", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-2000:])
                log(f"FAILED in {p}: {e}")
                return 1
            run.set(p, "complete", seconds=round(time.time() - t0, 1))
        if args.stop_after == p:
            log(f"stopping after {p} as requested")
            return 0
    log(f"done. Report: {run.p('idea_report.md' if phases is IDEA_PHASES else 'report.md')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
