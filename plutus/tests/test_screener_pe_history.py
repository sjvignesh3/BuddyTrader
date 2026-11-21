"""P/E history from Screener's chart API: the pure statistics and the one
request the client makes for them (migration 029)."""
from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal

from plutus.fundamentals import screener_client as sc

NOW = datetime(2026, 11, 21)


def _series(points):
    return [(d, Decimal(str(v))) for d, v in points]


class TestPeStats:
    def test_medians_low_high_per_window(self):
        s = _series([
            ("2017-01-06", 10), ("2018-01-05", 60),            # only in the 10Y window
            ("2022-06-03", 20), ("2023-06-02", 30),            # 5Y
            ("2024-06-07", 24), ("2025-06-06", 26), ("2026-06-05", 28),   # 3Y
        ])
        out = sc.pe_stats(s, now=NOW)
        assert out["pe_median_3y"] == Decimal("26.00")         # 24, 26, 28
        assert out["pe_median_5y"] == Decimal("26.00")         # 20 24 26 28 30
        assert out["pe_median_10y"] == Decimal("26.00")        # 7 values, middle = 26
        assert out["pe_low_10y"] == Decimal("10.00")
        assert out["pe_high_10y"] == Decimal("60.00")

    def test_even_count_median_averages_the_middle_pair(self):
        s = _series([("2025-01-03", 20), ("2025-06-06", 30), ("2026-01-02", 40), ("2026-06-05", 50)])
        assert sc.pe_stats(s, now=NOW)["pe_median_3y"] == Decimal("35.00")

    def test_empty_and_old_series(self):
        assert sc.pe_stats([], now=NOW) == {k: None for k in sc.PE_STAT_KEYS}
        old = _series([("2010-01-01", 15)])                     # outside every window
        out = sc.pe_stats(old, now=NOW)
        assert all(v is None for v in out.values())

    def test_series_mean_matches_legacy_average(self):
        s = _series([("2024-01-05", 20), ("2026-01-02", 30), ("2015-01-02", 999)])
        assert sc.series_mean(s, 5, now=NOW) == Decimal("25.00")
        assert sc.series_mean([], 5, now=NOW) is None


class _Resp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _Session:
    def __init__(self, payload):
        self.payload, self.headers, self.calls = payload, {}, []

    def get(self, url, **kw):
        self.calls.append((url, kw.get("params")))
        return _Resp(self.payload)


class TestChartSeries:
    def test_one_request_gives_series_and_drops_blanks(self):
        sess = _Session({"datasets": [{"metric": "Price to Earning", "values": [
            ["2024-01-05", "20.5"], ["2024-01-12", None], ["2024-01-19", "-3"], ["2024-01-26", "22"]]}]})
        cli = sc.ScreenerClient(session=sess)
        series = cli._chart_series(123, "Price to Earning")
        assert series == [("2024-01-05", Decimal("20.5")), ("2024-01-26", Decimal("22"))]
        assert len(sess.calls) == 1
        assert sess.calls[0][1] == {"q": "Price to Earning", "days": 3650}
        # the mean reuses the series instead of fetching again
        assert cli._chart_avg(123, "Price to Earning", years=5, series=series) == Decimal("21.25")
        assert len(sess.calls) == 1

    def test_failure_is_an_empty_series(self):
        class Boom:
            headers = {}

            def get(self, *a, **k):
                raise RuntimeError("offline")
        cli = sc.ScreenerClient(session=Boom())
        assert cli._chart_series(1, "Price to Earning") == []
        assert cli._chart_avg(1, "Price to Earning") is None
