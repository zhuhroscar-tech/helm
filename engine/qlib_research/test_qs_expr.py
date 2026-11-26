"""Parity tests: qs_expr (no qlib) against qlib 0.9.7's own output, recorded in fixtures/ by
fixtures/make_expr_fixtures.py. Run: python test_qs_expr.py  (no Qlib, no pytest needed)."""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import qs_expr as X  # noqa: E402
import qs_idea as I  # noqa: E402

FIX = HERE / "fixtures"
SPEC = json.loads((FIX / "expr_cases.json").read_text())
EXP = np.load(FIX / "expr_expected.npz")
DATA = X.BinData(FIX / "expr_provider")
T = SPEC["tickers"]


def compare(got: np.ndarray, exp: np.ndarray):
    """None if equal enough, else a short reason. NaN / inf positions must match exactly; finite values to
    float32 precision, relative to the formula's typical size (so near-zero values are not over-judged)."""
    if got.shape != exp.shape:
        return f"shape {got.shape} vs {exp.shape}"
    gn, en = np.isnan(got), np.isnan(exp)
    if (gn != en).any():
        i = np.argwhere(gn != en)[0]
        return f"NaN mismatch at {len(np.argwhere(gn != en))} cells, first {tuple(i)}: got {got[tuple(i)]} want {exp[tuple(i)]}"
    gi, ei = np.isinf(got), np.isinf(exp)
    if (gi != ei).any() or (got[gi] != exp[ei]).any():
        return "inf mismatch"
    ok = ~en & ~ei
    g, e = got[ok].astype("float64"), exp[ok].astype("float64")
    if not len(e):
        return None
    scale = max(float(np.median(np.abs(e))), 1e-12)
    bad = np.abs(g - e) > 2e-6 * np.maximum(np.abs(e), scale)
    if bad.any():
        j = np.argmax(np.abs(g - e) / np.maximum(np.abs(e), scale))
        return f"{bad.sum()} cells differ, worst got {g[j]!r} want {e[j]!r}"
    return None


def _run(cases, prefix, start):
    fails, n = [], 0
    for i, c in enumerate(cases):
        key = f"{prefix}{i}"
        if key not in EXP.files:
            continue  # qlib could not evaluate it (recorded in qlib_failed)
        got = X.expr_wide_f32(c, T, start, SPEC["end"], DATA).to_numpy()
        assert np.isfinite(EXP[key]).sum() > 1000, f"{c}: fixture is almost empty"
        n += 1
        why = compare(got, EXP[key])
        if why:
            fails.append(f"{c}: {why}")
    assert not fails, "\n  " + "\n  ".join(fails)
    return n


def test_parity_full_range():
    assert _run(SPEC["cases"], "c", SPEC["start"]) == len(SPEC["cases"]) - len(SPEC["qlib_failed"])


def test_parity_late_start():
    """qlib loads each ticker from (start - lookback): expanding operators restart at the start date."""
    assert _run(SPEC["late_cases"], "l", SPEC["late_start"]) == len(SPEC["late_cases"])


def test_every_operator_is_covered():
    used = set()

    def walk(n):
        if n[0] == "call":
            used.add(n[1])
            for a in n[2]:
                walk(a)
        elif n[0] == "bin":
            used.add(n[1])
            walk(n[2])
            walk(n[3])
        elif n[0] == "neg":
            walk(n[1])
    for c in SPEC["cases"]:
        walk(I.parse_expr(c))
    missing = {k for k, v in I.OPS.items() if v is not None} - used
    assert not missing, f"no parity case for {sorted(missing)}"


def test_compare_catches_small_errors():
    e = EXP["c7"]  # Mean($close,20)
    assert compare(e, e) is None
    assert compare(e * np.float32(1.00001), e) is not None
    g = e.copy(); g[500, 0] = np.nan
    assert compare(g, e) is not None


def test_corr_cov_window_zero_rejected_in_chinese():
    for f in ("Cov($close,$volume,0)", "Corr($close,$volume,0)"):
        try:
            X.expr_wide(f, T, SPEC["start"], None, DATA)
        except I.IdeaError as e:
            assert "窗口不能是 0" in str(e)
        else:
            raise AssertionError(f"{f} should be rejected")


def test_not_on_numbers_rejected():
    try:
        X.expr_wide("Not($close)", T, SPEC["start"], None, DATA)
    except I.IdeaError as e:
        assert "比较" in str(e)
    else:
        raise AssertionError("Not($close) should be rejected")


def test_unary_minus_works():
    a = X.expr_wide("-Std($close,20)", T, SPEC["start"], None, DATA)
    b = X.expr_wide("Std($close,20)", T, SPEC["start"], None, DATA)
    assert np.allclose(a.fillna(0), -b.fillna(0))


def test_no_look_ahead():
    """Values up to a date do not change when later data is cut off."""
    cal = DATA.calendar
    cut = cal[900]
    for c in ("Mean($close,20)", "Slope($close,20)", "Rank($close,0)", "EMA($close,10)", "Resi($close,0)"):
        full = X.expr_wide(c, T, SPEC["start"], None, DATA).loc[:cut]
        part = X.expr_wide(c, T, SPEC["start"], cut, DATA)
        pd.testing.assert_frame_equal(full, part)


def test_full_history_mode_differs_only_where_expected():
    """qlib_compat=False uses all history: a 20-day mean is the same, an expanding mean is not."""
    s = SPEC["late_start"]
    a = X.expr_wide("Mean($close,20)", T, s, None, DATA, qlib_compat=False)
    b = X.expr_wide("Mean($close,20)", T, s, None, DATA)
    pd.testing.assert_frame_equal(a, b)
    a = X.expr_wide("Mean($close,0)", T, s, None, DATA, qlib_compat=False)
    b = X.expr_wide("Mean($close,0)", T, s, None, DATA)
    assert not np.allclose(a["AAPL"], b["AAPL"])


def test_missing_field_leaves_that_ticker_empty():
    """qlib crashes the whole query when a field is missing for one ticker; qs_expr leaves that ticker NaN."""
    class Gappy(X.BinData):
        def field(self, t, f):
            s = super().field(t, f)
            return s.iloc[:0] if (t, f) == ("KO", "mkt") else s
    d = Gappy(FIX / "expr_provider")
    for f in ("Corr($close/Ref($close,1)-1,$mkt,60)", "If(Gt($close,$open),$mkt,1)"):
        w = X.expr_wide(f, T, SPEC["start"], None, d)
        assert w["KO"].isna().all() and w["AAPL"].notna().sum() > 1000, f
        assert "KO" in w.attrs["failed"] and len(w.attrs["failed"]) == 1


def test_runs_without_qlib():
    assert sys.modules.get("qlib") is None, "qs_expr / qs_idea imported qlib"


if __name__ == "__main__":
    sys.modules["qlib"] = None  # any `import qlib` now raises ImportError
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print("ALL PASSED")
