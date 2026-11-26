"""Tests for helm_data.HelmVol (volatility forecast + position scale). Run: python3 -I engine/test_helm_vol.py
Pure Python, no LEAN needed. Exits non-zero on the first failure."""
import datetime as dt
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helm_data as H  # noqa: E402

D0 = dt.date(2005, 1, 3)
day = lambda k: D0 + dt.timedelta(days=k)  # noqa: E731


def garch(n, seed=1, omega=2e-6, alpha=0.08, beta=0.9):
    """Simulated daily returns with volatility clustering (GARCH(1,1)); returns (returns, true daily variances)."""
    rnd = random.Random(seed)
    var, out, vs = omega / (1 - alpha - beta), [], []
    for _ in range(n):
        vs.append(var)
        r = rnd.gauss(0, math.sqrt(var))
        out.append(r)
        var = omega + alpha * r * r + beta * var
    return out, vs


def test_no_lookahead():
    rets, _ = garch(1500, seed=2)
    full = H.HelmVol()
    seq = []
    for k, r in enumerate(rets):
        full.update(day(k), r)
        seq.append(full.forecast())
    for t in (30, 400, 700, 1100, 1499):  # a fresh model fed only up to t must give the same forecast
        fresh = H.HelmVol()
        fresh.warmup([(day(k), rets[k]) for k in range(t + 1)])
        f = fresh.forecast()
        assert (f is None and seq[t] is None) or abs(f - seq[t]) < 1e-12, (t, f, seq[t])


def _losses(rets, model_factory, true_var, h=21, start=600):
    m = model_factory()
    mse, qlike, n = 0.0, 0.0, 0
    for k, r in enumerate(rets):
        if k >= start and k + h < len(rets):
            f = m.forecast()
            if f is not None:
                pv = f * f / 252.0
                rv = sum(true_var[k + 1:k + 1 + h]) / h  # the true variance over the next h days (known in a simulation)
                mse += (pv - rv) ** 2
                qlike += rv / pv + math.log(pv)
                n += 1
        m.update(day(k), r)
    return mse / n, qlike / n


class Constant:
    """Naive baseline: long-run historical variance (what a fixed-size strategy implicitly assumes)."""
    def __init__(self):
        self.r2 = []

    def update(self, when, r):
        self.r2.append(r * r)

    def forecast(self):
        return math.sqrt(252 * sum(self.r2) / len(self.r2)) if len(self.r2) > 21 else None


def test_forecast_beats_constant_on_clustered_volatility():
    rets, tv = garch(4000, seed=3)
    har = _losses(rets, lambda: H.HelmVol(method="har"), tv)
    ewma = _losses(rets, lambda: H.HelmVol(method="ewma"), tv)
    const = _losses(rets, Constant, tv)
    assert har[1] < const[1] and ewma[1] < const[1], (har, ewma, const)   # QLIKE
    assert har[0] < const[0], (har, const)                                 # MSE
    assert har[1] <= ewma[1] + 0.01, (har, ewma)  # HAR at least about as good as EWMA (QLIKE is negative here: compare with an absolute margin)


def test_fallbacks_and_sources():
    rets, _ = garch(800, seed=4)
    v = H.HelmVol(min_history=504)
    assert v.forecast() is None and v.scale() == 1.0
    for k in range(21):
        v.update(day(k), rets[k])
    assert v.forecast() is None and v.scale() == 1.0          # < 22 days: no forecast, no change
    for k in range(21, 300):
        v.update(day(k), rets[k])
    v.forecast()
    assert v.last_source == "ewma"                              # not enough history for HAR yet
    for k in range(300, 800):
        v.update(day(k), rets[k])
    v.forecast()
    assert v.last_source == "har"


def test_scale_rules():
    v = H.HelmVol(target=0.10, max_leverage=1.0)
    rnd = random.Random(5)
    for k in range(100):
        v.update(day(k), rnd.gauss(0, 0.02))                   # ~32% annual vol
    f = v.forecast()
    assert abs(v.scale() - 0.10 / f) < 1e-12 and v.scale() < 0.5
    calm = H.HelmVol(target=0.10, max_leverage=1.0)
    for k in range(100):
        calm.update(day(k), rnd.gauss(0, 0.001))               # ~1.6% annual vol
    assert calm.scale() == 1.0                                  # capped: never levers up past max_leverage
    lev = H.HelmVol(target=0.10, max_leverage=2.0)
    for k in range(100):
        lev.update(day(k), rnd.gauss(0, 0.001))
    assert lev.scale() == 2.0
    floor = H.HelmVol(target=0.10, min_scale=0.3)
    for k in range(100):
        floor.update(day(k), rnd.gauss(0, 0.05))
    assert floor.scale() == 0.3


def test_input_validation():
    v = H.HelmVol()
    v.update("2024-01-02", 0.01)
    try:
        v.update("2024-01-02", 0.01)
        raise AssertionError("same date accepted")
    except ValueError:
        pass
    v.update("2024-01-03", float("nan"))
    v.update("2024-01-04", None)
    v.update("2024-01-05", 3.0)                                  # +300% in a day: bad data, ignored
    assert len(v._r2) == 1
    for bad in (dict(target=0), dict(max_leverage=5), dict(method="garch"), dict(horizon=0)):
        try:
            H.HelmVol(**bad)
            raise AssertionError(f"accepted {bad}")
        except ValueError:
            pass


def _max_dd(rets):
    nav, peak, dd = 1.0, 1.0, 0.0
    for r in rets:
        nav *= 1 + r
        peak = max(peak, nav)
        dd = max(dd, 1 - nav / peak)
    return dd


def test_vol_targeting_reduces_drawdown_without_lookahead():
    """Position for day t uses the forecast made after day t-1 only. On clustered volatility the scaled
    series has lower drawdown and realised vol closer to the target than holding a fixed full position."""
    rets, _ = garch(3000, seed=6, omega=4e-6)  # ~20%+ annual vol, strong clustering
    v = H.HelmVol(target=0.10, max_leverage=1.0)
    scaled = []
    for k, r in enumerate(rets):
        w = v.scale()            # decided before today's return is known
        scaled.append(w * r)
        v.update(day(k), r)      # today's return becomes known after the close
    tail = slice(600, None)
    sd = lambda x: math.sqrt(sum(y * y for y in x) / len(x)) * math.sqrt(252)  # noqa: E731
    assert _max_dd(scaled[tail]) < _max_dd(rets[tail]), (_max_dd(scaled[tail]), _max_dd(rets[tail]))
    assert abs(sd(scaled[tail]) - 0.10) < abs(sd(rets[tail]) - 0.10)


def test_speed():
    import time
    rets, _ = garch(5000, seed=7)
    v = H.HelmVol()
    t0 = time.time()
    for k, r in enumerate(rets):
        v.update(day(k), r)
        v.scale()
    assert time.time() - t0 < 2.0, time.time() - t0  # 20 years of daily updates must not slow a backtest


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                fails += 1
                print(f"FAIL {name}: {e!r}")
    print("ALL PASSED" if not fails else f"{fails} FAILED")
    sys.exit(1 if fails else 0)
