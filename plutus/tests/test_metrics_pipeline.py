"""Integration tests for compute_snapshot orchestrator."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from plutus.metrics.pipeline import SnapshotInputs, compute_snapshot
from plutus.registry.fields import fields_for
from plutus.tests.fixtures.synthetic_ohlcv import flat_series, linear_up_series


class TestPipelineHappy:
    def test_flat_series_snapshot(self) -> None:
        bars = flat_series(price="100.00", n=210)
        inp = SnapshotInputs(
            symbol="TEST.NS",
            # As-of the newest bar — the pipeline drops bars newer than the
            # snapshot date, and the 200-DMA needs the full window intact.
            snapshot_date=bars[-1].d,
            bars=bars,
            info={"marketCap": 60_000 * 10_000_000,
                  "trailingPE": 25.0, "priceToBook": 3.0,
                  "volume": 1_000_000},
            meta={"regularMarketPrice": 100.00,
                  "fiftyTwoWeekHigh": 100.00, "fiftyTwoWeekLow": 100.00},
        )
        row = compute_snapshot(inp)

        assert row["symbol"] == "TEST.NS"
        assert row["snapshot_date"] == bars[-1].d
        assert row["close"] == Decimal("100.00")
        assert row["dma_200"] == Decimal("100.00")
        assert row["below_200dma_pct"] == Decimal("0.00")
        assert row["high_52w"] == Decimal("100.00")
        assert row["low_52w"] == Decimal("100.00")
        assert row["ath"] == Decimal("100.00")
        assert row["fall_from_ath_pct"] == Decimal("0.00")
        assert row["market_cap"] == Decimal(60_000 * 10_000_000)
        assert row["cap_bucket"] == "Large"
        assert row["pe_current"] == Decimal("25.00")
        assert row["pb_current"] == Decimal("3.00")
        assert row["volume"] == 1_000_000
        # No rally on flat series
        assert row["has_valid_20pct_rally"] is False
        assert row["errors"] == []


class TestPipelinePartialFailure:
    def test_no_bars_returns_partial_row_with_error(self) -> None:
        inp = SnapshotInputs(
            symbol="EMPTY.NS", snapshot_date=date(2024, 1, 1),
            bars=[], info={},
        )
        row = compute_snapshot(inp)
        assert row["symbol"] == "EMPTY.NS"
        assert row["close"] is None
        assert row["dma_200"] is None
        assert len(row["errors"]) == 1
        assert "no OHLCV" in row["errors"][0]

    def test_unparseable_market_cap_is_treated_as_missing(self) -> None:
        # to_decimal returns None for garbage strings — pipeline should
        # silently treat as missing rather than logging spurious errors.
        bars = flat_series(price="50.00", n=5)
        inp = SnapshotInputs(
            symbol="BAD.NS", snapshot_date=date(2024, 1, 5),
            bars=bars,
            info={"marketCap": "not-a-number"},
        )
        row = compute_snapshot(inp)
        assert row["market_cap"] is None
        assert row["cap_bucket"] is None
        # Other fields still computed cleanly. (dma_200 is None here by
        # design: 5 bars < the 200-bar window — a fake DMA must not ship.)
        assert row["close"] == Decimal("50.00")
        assert row["dma_200"] is None
        assert any("dma_200" in e for e in row["errors"])

    def test_type_error_market_cap_is_recorded(self) -> None:
        # A bool triggers TypeError inside to_decimal — pipeline must catch.
        bars = flat_series(price="50.00", n=5)
        inp = SnapshotInputs(
            symbol="BOOLMC.NS", snapshot_date=date(2024, 1, 5),
            bars=bars,
            info={"marketCap": True},
        )
        row = compute_snapshot(inp)
        assert row["market_cap"] is None
        assert row["cap_bucket"] is None
        assert any("market_cap" in e for e in row["errors"])


class TestPipelineRegistryContract:
    def test_all_output_keys_are_daily_snapshot_fields_or_bookkeeping(self) -> None:
        """
        Every key returned by compute_snapshot must either be a registered
        daily_snapshots column or the 'errors' bookkeeping field.
        This is the grep gate that keeps pipeline output aligned with the DB.
        """
        bars = linear_up_series(n=30)
        inp = SnapshotInputs(
            symbol="LIN.NS", snapshot_date=date(2024, 1, 1),
            bars=bars, info={}, meta={},
        )
        row = compute_snapshot(inp)

        registered = {f.name for f in fields_for("daily_snapshots")}
        allowed_extra = {"errors"}
        unknown = set(row.keys()) - registered - allowed_extra
        assert not unknown, (
            f"compute_snapshot returned unregistered keys: {unknown}. "
            f"Either add them to the registry or remove from pipeline."
        )
