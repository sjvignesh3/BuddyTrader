"""
IPO journal — pure validation helpers + end-to-end routes on a writable fake.

Locks the contracts the Journal → IPOs tab relies on:
  * money is a 2-dp Decimal string, counts are whole numbers, symbols are
    plain NSE form;
  * only an ALLOTTED application carries shares (never more than applied
    for, never fewer than already sold), and one with sells cannot leave
    ALLOTTED;
  * a sell never exceeds the shares still held and never predates listing;
  * listing day = the first daily candle, refused when it predates the
    application (wrong symbol) and with no "close" while the day is live;
  * the market-data routes are offline-injectable and save nothing.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List

import pytest

from plutus.adapters.result import Result
from plutus.api.ipo import (
    IPO_FIELDS,
    bars_from_frame,
    clean_fields,
    listing_from_bars,
    normalize_symbol,
    validate_ipo,
    validate_sell,
)


def _app(**over) -> Dict[str, Any]:
    row = {"account": "Self", "ipo_name": "Acme Tech", "apply_date": "2026-10-01",
           "issue_price": "100.00", "lot_size": 150, "lots_applied": 1,
           "status": "APPLIED"}
    row.update(over)
    return row


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class TestClean:
    @pytest.mark.parametrize("raw,expected", [
        ("acmetech", "ACMETECH"), (" ACMETECH.NS ", "ACMETECH"), ("m&m.bo", "M&M"),
        ("BAJAJ-AUTO", "BAJAJ-AUTO"),
    ])
    def test_symbol(self, raw, expected):
        assert normalize_symbol(raw) == expected

    @pytest.mark.parametrize("raw", ["", "ACME TECH", "a" * 25, None, 5, "X?"])
    def test_symbol_rejects(self, raw):
        assert normalize_symbol(raw) is None

    def test_types_are_normalised(self):
        row = clean_fields({"issue_price": "1,234.5", "lot_size": "12", "apply_date":
                            "2026-10-01T00:00:00", "status": "allotted",
                            "symbol": "acme.ns", "junk": 1}, IPO_FIELDS)
        assert row == {"issue_price": Decimal("1234.50"), "lot_size": 12,
                       "apply_date": "2026-10-01", "status": "ALLOTTED", "symbol": "ACME"}

    def test_blank_clears_and_absent_is_untouched(self):
        assert clean_fields({"listing_open": "", "notes": "  "}, IPO_FIELDS) == \
            {"listing_open": None, "notes": None}
        assert clean_fields({}, IPO_FIELDS) == {}

    @pytest.mark.parametrize("payload,msg", [
        ({"issue_price": "abc"}, "issue_price must be a number"),
        ({"issue_price": "-5"}, "issue_price must be a positive price"),
        ({"issue_price": True}, "issue_price must be a number"),
        ({"lot_size": "1.5"}, "lot_size must be a whole number"),
        ({"lot_size": 0}, "lot_size must be a whole number"),
        ({"apply_date": "01/10/2026"}, "apply_date must be a date"),
        ({"status": "LISTED"}, "status must be one of"),
        ({"symbol": "ACME TECH"}, "not a valid NSE symbol"),
        ({"account": "x" * 31}, "account is longer than 30"),
    ])
    def test_rejects(self, payload, msg):
        with pytest.raises(ValueError, match=msg):
            clean_fields(payload, IPO_FIELDS)


class TestValidateIpo:
    def test_required(self):
        with pytest.raises(ValueError, match="issue_price is required"):
            validate_ipo(_app(issue_price=None), [])

    def test_non_allotted_drops_shares(self):
        assert validate_ipo(_app(status="NOT_ALLOTTED", shares_allotted=150), [])[
            "shares_allotted"] is None

    def test_allotted_needs_shares_within_applied(self):
        with pytest.raises(ValueError, match="shares_allotted is required"):
            validate_ipo(_app(status="ALLOTTED"), [])
        with pytest.raises(ValueError, match="more than you applied for \\(150\\)"):
            validate_ipo(_app(status="ALLOTTED", shares_allotted=151), [])
        assert validate_ipo(_app(status="ALLOTTED", shares_allotted=150), [])

    def test_shares_not_below_sold(self):
        sells = [{"sell_date": "2026-10-10", "qty": 100}]
        with pytest.raises(ValueError, match="less than the 100 shares already sold"):
            validate_ipo(_app(status="ALLOTTED", shares_allotted=90, lots_applied=2), sells)

    def test_sells_pin_the_status(self):
        sells = [{"sell_date": "2026-10-10", "qty": 10}]
        with pytest.raises(ValueError, match="delete them before"):
            validate_ipo(_app(status="NOT_ALLOTTED"), sells)

    def test_dates_never_run_backwards(self):
        with pytest.raises(ValueError, match="listing_date .* before the application"):
            validate_ipo(_app(listing_date="2026-09-30"), [])
        with pytest.raises(ValueError, match="allotment_date"):
            validate_ipo(_app(allotment_date="2026-09-01"), [])
        sells = [{"sell_date": "2026-10-07", "qty": 10}]
        with pytest.raises(ValueError, match="before listing"):
            validate_ipo(_app(status="ALLOTTED", shares_allotted=150,
                              listing_date="2026-10-08"), sells)


class TestValidateSell:
    ipo = _app(status="ALLOTTED", shares_allotted=150, listing_date="2026-10-08")

    def test_ok_and_partial(self):
        validate_sell(self.ipo, [{"qty": 100}],
                      {"sell_date": "2026-10-08", "sell_price": Decimal("120"), "qty": 50})

    def test_more_than_held(self):
        with pytest.raises(ValueError, match="more than the 50 shares still held"):
            validate_sell(self.ipo, [{"qty": 100}],
                          {"sell_date": "2026-10-09", "sell_price": Decimal("1"), "qty": 51})

    def test_before_listing(self):
        with pytest.raises(ValueError, match="before listing \\(2026-10-08\\)"):
            validate_sell(self.ipo, [],
                          {"sell_date": "2026-10-07", "sell_price": Decimal("1"), "qty": 1})

    def test_not_allotted(self):
        with pytest.raises(ValueError, match="only an allotted IPO"):
            validate_sell(_app(), [], {"sell_date": "2026-10-09",
                                       "sell_price": Decimal("1"), "qty": 1})


def _bar(d, o, c):
    return {"date": d, "open": Decimal(o), "close": Decimal(c)}


class TestListing:
    bars = [_bar("2026-10-09", "131.00", "128.40"), _bar("2026-10-08", "120.00", "126.55")]

    def test_first_candle_is_listing(self):
        out = listing_from_bars(self.bars, apply_date="2026-10-01", today="2026-11-01")
        assert out == {"listing_date": "2026-10-08", "listing_open": "120.00",
                       "listing_close": "126.55", "ltp": "128.40", "ltp_date": "2026-10-09"}

    def test_live_listing_day_has_no_close(self):
        out = listing_from_bars(self.bars[1:], today="2026-10-08")
        assert out["listing_close"] is None and out["listing_open"] == "120.00"

    def test_older_company_is_refused(self):
        with pytest.raises(ValueError, match="traded since 2026-10-08, before your application"):
            listing_from_bars(self.bars, apply_date="2026-10-20")

    def test_empty(self):
        with pytest.raises(ValueError, match="no trading history"):
            listing_from_bars([])

    def test_bars_from_frame(self):
        pd = pytest.importorskip("pandas")
        idx = pd.to_datetime(["2026-10-08", "2026-10-09", "2026-10-10"]).tz_localize("Asia/Kolkata")
        df = pd.DataFrame({"Open": [120.004, float("nan"), 130.0],
                           "Close": [126.555, 128.0, 0.0]}, index=idx)
        assert bars_from_frame(df) == [_bar("2026-10-08", "120.00", "126.56")]


# ---------------------------------------------------------------------------
# Writable in-memory fake — enough of the PostgREST builder for these routes.
# ---------------------------------------------------------------------------

class _Res:
    def __init__(self, data):
        self.data = data


class _Q:
    def __init__(self, db: "FakeDB", table: str):
        self._db, self._t = db, table
        self._filters: List[tuple] = []
        self._op, self._payload, self._order, self._limit = "select", None, None, None

    def select(self, *_a, **_k): return self
    def insert(self, payload): self._op, self._payload = "insert", payload; return self
    def update(self, payload): self._op, self._payload = "update", payload; return self
    def delete(self): self._op = "delete"; return self
    def eq(self, col, val): self._filters.append((col, val)); return self
    def order(self, col, desc=False): self._order = (col, desc); return self
    def limit(self, n): self._limit = n; return self

    def _match(self, r):
        return all(r.get(c) == v for c, v in self._filters)

    def execute(self):
        rows = self._db.tables.setdefault(self._t, [])
        if self._op == "insert":
            payload = self._payload if isinstance(self._payload, list) else [self._payload]
            out = []
            for p in payload:
                row = dict(p)
                row.setdefault("id", self._db.next_id())
                rows.append(row)
                out.append(dict(row))
            return _Res(out)
        if self._op == "update":
            out = []
            for r in rows:
                if self._match(r):
                    r.update(self._payload)
                    out.append(dict(r))
            return _Res(out)
        if self._op == "delete":
            self._db.tables[self._t] = [r for r in rows if not self._match(r)]
            return _Res([])
        sel = [dict(r) for r in rows if self._match(r)]
        if self._order:
            col, desc = self._order
            sel.sort(key=lambda r: str(r.get(col)), reverse=desc)
        return _Res(sel[: self._limit] if self._limit is not None else sel)


class FakeDB:
    def __init__(self):
        self.tables: Dict[str, List[Dict[str, Any]]] = {"ipo_applications": [], "ipo_sells": []}
        self._id = 0

    def next_id(self):
        self._id += 1
        return self._id

    def table(self, name):
        return _Q(self, name)


CANDLES = {
    "ACME": [_bar("2026-10-08", "120.00", "126.55"), _bar("2026-10-09", "131.00", "128.40")],
    "OLDCO": [_bar("2015-01-01", "50.00", "51.00")],
}


def fake_daily(symbol: str, period: str):
    if symbol in CANDLES:
        bars = CANDLES[symbol]
        return Result.success(bars[-1:] if period == "5d" else bars, symbol=symbol)
    return Result.failure("empty history", symbol=symbol)


@pytest.fixture
def db():
    return FakeDB()


@pytest.fixture
def client(db):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from plutus.api import create_app
    return TestClient(create_app(supabase_client=db, fetch_daily=fake_daily))


def _create(client, **over):
    body = {"account": "Father", "ipo_name": "Acme Tech", "apply_date": "2026-10-01",
            "issue_price": "100", "lot_size": "150", "lots_applied": 2}
    body.update(over)
    r = client.post("/api/journal/ipos", json=body)
    assert r.status_code == 200, r.text
    return r.json()["ipo"]


class TestRoutes:
    def test_create_list_roundtrip(self, client, db):
        ipo = _create(client, symbol="acme.ns")
        assert ipo["status"] == "APPLIED" and ipo["symbol"] == "ACME"
        assert ipo["issue_price"] == "100.00" and ipo["sells"] == []
        listed = client.get("/api/journal/ipos").json()
        assert listed["count"] == 1 and listed["ipos"][0]["account"] == "Father"

    def test_account_defaults_to_self(self, client):
        assert _create(client, account=None)["account"] == "Self"

    def test_bad_input_is_400_not_502(self, client):
        r = client.post("/api/journal/ipos", json={"ipo_name": "X", "apply_date": "2026-10-01",
                                                  "issue_price": "abc", "lot_size": 1,
                                                  "lots_applied": 1})
        assert r.status_code == 400 and "issue_price" in r.json()["error"]

    def test_allot_sell_and_guards(self, client, db):
        ipo = _create(client)
        r = client.put(f"/api/journal/ipos/{ipo['id']}",
                       json={"status": "ALLOTTED", "shares_allotted": 150,
                             "listing_date": "2026-10-08", "listing_open": "120"})
        assert r.status_code == 200, r.text

        r = client.post(f"/api/journal/ipos/{ipo['id']}/sells",
                        json={"sell_date": "2026-10-08", "sell_price": "125.5", "qty": 100})
        assert r.status_code == 200, r.text
        sells = r.json()["ipo"]["sells"]
        assert len(sells) == 1 and sells[0]["sell_price"] == "125.50"

        too_many = client.post(f"/api/journal/ipos/{ipo['id']}/sells",
                               json={"sell_date": "2026-10-09", "sell_price": "130", "qty": 51})
        assert too_many.status_code == 400 and "50 shares still held" in too_many.json()["error"]

        # Sells pin the status and the share count.
        r = client.put(f"/api/journal/ipos/{ipo['id']}", json={"status": "NOT_ALLOTTED"})
        assert r.status_code == 400
        r = client.put(f"/api/journal/ipos/{ipo['id']}", json={"shares_allotted": 99})
        assert r.status_code == 400

        # Editing a sell re-checks against the OTHER sells only.
        sid = sells[0]["id"]
        assert client.put(f"/api/journal/ipos/sells/{sid}", json={"qty": 150}).status_code == 200
        assert client.put(f"/api/journal/ipos/sells/{sid}", json={"qty": 151}).status_code == 400

        r = client.delete(f"/api/journal/ipos/sells/{sid}")
        assert r.status_code == 200 and r.json()["ipo"]["sells"] == []

    def test_status_change_clears_shares(self, client, db):
        ipo = _create(client, status="ALLOTTED", shares_allotted=150)
        r = client.put(f"/api/journal/ipos/{ipo['id']}", json={"status": "NOT_ALLOTTED"})
        assert r.status_code == 200
        assert db.tables["ipo_applications"][0]["shares_allotted"] is None

    def test_delete_removes_sells(self, client, db):
        ipo = _create(client, status="ALLOTTED", shares_allotted=150)
        client.post(f"/api/journal/ipos/{ipo['id']}/sells",
                    json={"sell_date": "2026-10-08", "sell_price": "125", "qty": 10})
        assert client.delete(f"/api/journal/ipos/{ipo['id']}").status_code == 200
        assert db.tables["ipo_applications"] == [] and db.tables["ipo_sells"] == []
        assert client.delete(f"/api/journal/ipos/{ipo['id']}").status_code == 404

    def test_listing_lookup(self, client, db):
        r = client.get("/api/journal/ipos/listing?symbol=acme&apply_date=2026-10-01")
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["symbol"] == "ACME" and j["listing_date"] == "2026-10-08"
        assert j["listing_open"] == "120.00" and j["ltp"] == "128.40"
        assert db.tables["ipo_applications"] == []          # lookup saves nothing

    def test_listing_lookup_errors(self, client):
        assert client.get("/api/journal/ipos/listing?symbol=NOPE").status_code == 404
        r = client.get("/api/journal/ipos/listing?symbol=OLDCO&apply_date=2026-10-01")
        assert r.status_code == 422 and "check the symbol" in r.json()["error"]
        assert client.get("/api/journal/ipos/listing?symbol=bad%20sym").status_code == 400

    def test_quotes_isolate_failures(self, client):
        r = client.get("/api/journal/ipos/quotes?symbols=acme,NOPE,ACME")
        j = r.json()
        assert j["quotes"] == {"ACME": {"ltp": "128.40", "date": "2026-10-09"}}
        assert set(j["errors"]) == {"NOPE"}
