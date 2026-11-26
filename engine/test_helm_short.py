"""Tests for helm_data.HelmShortCost (borrow fee on short positions). Run: python3 -I engine/test_helm_short.py
Pure Python with a fake algorithm object, no LEAN needed. Exits non-zero on the first failure."""
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helm_data as H  # noqa: E402


class Sym:
    def __init__(self, v):
        self.value = v


class Holding:
    def __init__(self, t, q, px):
        self.symbol, self.quantity, self.price = Sym(t), q, px

    @property
    def holdings_value(self):
        return self.quantity * self.price


class Cash:
    def __init__(self, pf):
        self.pf = pf

    def add_amount(self, x):
        self.pf.cash += x


class Portfolio(dict):
    def __init__(self, cash):
        super().__init__()
        self.cash = cash
        self.cash_book = {"USD": Cash(self)}


class Algo:
    def __init__(self, cash=100000.0):
        self.portfolio = Portfolio(cash)
        self.time = dt.datetime(2020, 1, 6, 16)  # Monday

    def hold(self, t, q, px):
        self.portfolio[t] = Holding(t, q, px)


def close(a, b, tol=1e-6):
    return abs(a - b) <= tol * max(1.0, abs(b))


def test_daily_fee_and_weekend():
    a = Algo()
    a.hold("SPY", 100, 300.0)        # long: never charged
    a.hold("XYZ", -100, 100.0)       # short $10,000
    c = H.HelmShortCost(rate=0.036)  # 3.6%/360 = 0.01% per day = $1/day
    f1 = c.charge(a)
    assert close(f1, 1.0), f1
    assert close(a.portfolio.cash, 100000 - 1.0)
    assert c.charge(a) == 0.0, "same day must not charge twice"
    a.time = dt.datetime(2020, 1, 10, 16)  # Friday
    c.charge(a)
    a.time = dt.datetime(2020, 1, 13, 16)  # Monday: 3 calendar days incl. weekend
    f = c.charge(a)
    assert close(f, 3.0), f
    assert close(c.total, 1 + 4 + 3), c.total
    assert close(a.portfolio.cash, 100000 - c.total)
    assert c.days_short == 3 and close(c.max_short_value, 10000)


def test_no_shorts_no_fee():
    a = Algo()
    a.hold("SPY", 10, 300.0)
    c = H.HelmShortCost()
    assert c.charge(a) == 0.0 and a.portfolio.cash == 100000.0 and c.total == 0.0 and c.days_short == 0


def test_rates_and_htb():
    a = Algo()
    a.hold("AAA", -10, 360.0)   # $3,600
    a.hold("GME", -10, 360.0)   # $3,600, hard to borrow
    a.hold("TSLA", -10, 360.0)  # $3,600, own rate
    c = H.HelmShortCost(rate=0.01, rates={"tsla": 0.02}, hard_to_borrow=["gme"], htb_rate=0.50)
    f = c.charge(a)
    assert close(f, 3600 * (0.01 + 0.50 + 0.02) / 360), f
    assert c.rate_for("GME") == 0.50 and c.rate_for("TSLA") == 0.02 and c.rate_for("AAA") == 0.01
    assert max(c.by_symbol, key=c.by_symbol.get) == "GME"
    assert "GME" in c.summary()


def test_fee_follows_price_no_lookahead():
    a = Algo()
    a.hold("XYZ", -100, 100.0)
    c = H.HelmShortCost(rate=0.036)
    c.charge(a)
    a.portfolio["XYZ"].price = 200.0  # short got more expensive: fee from today on doubles, past fee unchanged
    a.time = dt.datetime(2020, 1, 7, 16)
    assert close(c.charge(a), 2.0)
    assert close(c.total, 3.0)


def test_pascal_case_and_set_cash_fallback():
    class P:
        def __init__(self):
            self.Cash = 5000.0
            self.Values = [type("Hd", (), {"Quantity": -1, "HoldingsValue": -3600.0, "Symbol": type("S", (), {"Value": "Q"})()})()]

        def SetCash(self, x):
            self.Cash = x

    class A2:
        def __init__(self):
            self.Portfolio, self.Time = P(), dt.datetime(2021, 3, 1)

    a = A2()
    c = H.HelmShortCost(rate=0.10)
    f = c.charge(a)
    assert close(f, 1.0) and close(a.Portfolio.Cash, 4999.0), (f, a.Portfolio.Cash)


def test_bad_rate_rejected():
    for kw in ({"rate": -0.1}, {"rate": 5}, {"rates": {"X": 3}}):
        try:
            H.HelmShortCost(**kw)
        except ValueError:
            continue
        raise AssertionError(f"accepted {kw}")


def test_exported():
    assert "HelmShortCost" in H.__all__


if __name__ == "__main__":
    n = 0
    for k, fn in list(globals().items()):
        if k.startswith("test_") and callable(fn):
            fn()
            n += 1
            print("PASS", k)
    print(f"ALL PASSED ({n})")
