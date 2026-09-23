"""
Universe routes — pure helpers + end-to-end route tests on a writable fake.

Locks the contracts the Universe page relies on:
  * symbols canonicalise to yfinance form, cap types / sector groups to the
    one vocabulary the rest of Plutus uses;
  * a replace-mode import diff is exact, merge-mode never removes;
  * removing a stock's last pool retires it (active=false) — UNLESS the
    Trading Journal still references it — and never deletes the row;
  * every applied import leaves a universe_syncs audit row;
  * criteria are stored as strings (no float).
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest

from plutus.api.universe import (
    canonical_symbol,
    clean_criteria,
    compute_pool_diff,
    normalize_cap_type,
    normalize_sector_group,
    parse_import_rows,
    plain_symbol,
)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class TestSymbols:
    @pytest.mark.parametrize("raw,expected", [
        ("tcs", "TCS.NS"), (" TCS ", "TCS.NS"), ("TCS.NS", "TCS.NS"),
        ("tcs.ns", "TCS.NS"), ("500325.BO", "500325.BO"), ("M&M", "M&M.NS"),
        ("BAJAJ-AUTO", "BAJAJ-AUTO.NS"),
    ])
    def test_canonical(self, raw, expected):
        assert canonical_symbol(raw) == expected

    @pytest.mark.parametrize("raw", ["", "  ", None, 42, "TCS INFY", "a" * 30, "TCS.XX?"])
    def test_canonical_rejects(self, raw):
        assert canonical_symbol(raw) is None

    def test_plain(self):
        assert plain_symbol("TCS.NS") == "TCS"
        assert plain_symbol("tcs.bo") == "TCS"
        assert plain_symbol("TCS") == "TCS"


class TestVocabulary:
    @pytest.mark.parametrize("raw,expected", [
        ("Large Cap", "Large"), ("large", "Large"), ("MID", "Mid"), ("Smallcap", "Small"),
        ("Micro Cap", "Micro"), ("#N/A", None), ("", None), (None, None), ("Huge", None),
    ])
    def test_cap(self, raw, expected):
        assert normalize_cap_type(raw) == expected

    @pytest.mark.parametrize("raw,expected", [
        ("Banks", "Banks"), ("bank", "Banks"), ("NBFC", "NBFC"), ("Non-Banking", "NBFC"),
        ("Normal", "Normal"), ("AUTO", None), ("", None), (None, None),
    ])
    def test_group(self, raw, expected):
        assert normalize_sector_group(raw) == expected


class TestImportParsing:
    def test_master_template_s200_labels_classify(self):
        rows, rejects = parse_import_rows([
            {"symbol": "hdfcbank", "sector": "Banks", "cap": "Large Cap"},
            {"symbol": "BAJFINANCE", "sector": "NBFC"},
            {"symbol": "TCS", "sector": "Normal", "cap": "Large Cap"},
            {"symbol": "??", "sector": "X"},
        ])
        by = {r["symbol"]: r for r in rows}
        assert by["HDFCBANK.NS"]["sector_group"] == "Banks"
        assert by["HDFCBANK.NS"]["cap_type_manual"] == "Large"
        assert by["BAJFINANCE.NS"]["sector_group"] == "NBFC"
        # 'Normal' is the criteria label, not a sector — moved, not kept.
        assert by["TCS.NS"]["sector_group"] == "Normal"
        assert "sector" not in by["TCS.NS"]
        assert rejects == [{"symbol": "??", "reason": "not a valid NSE/BSE symbol"}]

    def test_duplicates_collapse(self):
        rows, _ = parse_import_rows([
            {"symbol": "TCS", "sector": "IT"},
            {"symbol": "TCS.NS", "cap_type": "Large"},
        ])
        assert rows == [{"symbol": "TCS.NS", "sector": "IT", "cap_type_manual": "Large"}]


class TestDiff:
    CURRENT = {
        "TCS.NS": {"symbol": "TCS.NS", "pools": ["F40", "S200"], "sector": "IT",
                   "cap_type_manual": "Large", "sector_group": "Normal"},
        "INFY.NS": {"symbol": "INFY.NS", "pools": ["F40"], "sector": "IT",
                    "cap_type_manual": None, "sector_group": None},
        "OLD.NS": {"symbol": "OLD.NS", "pools": ["F40"], "active": True},
        "SBIN.NS": {"symbol": "SBIN.NS", "pools": ["S200"]},
    }

    def test_replace_is_exact(self):
        d = compute_pool_diff("F40", self.CURRENT, [
            {"symbol": "TCS.NS", "sector": "IT"},                 # unchanged
            {"symbol": "INFY.NS", "cap_type_manual": "Large"},    # updated
            {"symbol": "SBIN.NS"},                                # added (exists, other pool)
            {"symbol": "NEW.NS", "sector": "Auto"},               # added (new stock)
        ], mode="replace")
        assert d["added"] == ["NEW.NS", "SBIN.NS"]
        assert d["updated"] == ["INFY.NS"]
        assert d["removed"] == ["OLD.NS"]
        assert d["unchanged"] == 1
        assert d["new_stocks"] == ["NEW.NS"]

    def test_merge_never_removes(self):
        d = compute_pool_diff("F40", self.CURRENT, [{"symbol": "NEW.NS"}], mode="merge")
        assert d["removed"] == []
        assert d["added"] == ["NEW.NS"]


class TestCriteria:
    def test_defaults_and_strings(self):
        c = clean_criteria({})
        assert c["normal"]["net_debt_to_equity_max"] == "0.25"
        assert c["banks_nbfc"]["net_profit_min_cr"] == "1000"
        for g in c.values():
            for v in g.values():
                assert isinstance(v, str)

    def test_override_and_reject(self):
        c = clean_criteria({"normal": {"roce_min": 15}, "banks_nbfc": {"roe_min": "12.5"}})
        assert c["normal"]["roce_min"] == "15"
        assert c["banks_nbfc"]["roe_min"] == "12.5"
        with pytest.raises(ValueError):
            clean_criteria({"normal": {"roce_min": "abc"}})
        with pytest.raises(ValueError):
            clean_criteria({"normal": {"roce_min": "-1"}})


# ---------------------------------------------------------------------------
# Writable in-memory fake — enough of the PostgREST builder for these routes.
# ---------------------------------------------------------------------------

class _Res:
    def __init__(self, data: List[Dict[str, Any]]):
        self.data = data


class _Q:
    def __init__(self, db: "FakeDB", table: str):
        self._db, self._t = db, table
        self._filters: List[tuple] = []
        self._op = "select"
        self._payload: Any = None
        self._order = None
        self._limit = None

    def select(self, *_a, **_k): return self
    def insert(self, payload): self._op, self._payload = "insert", payload; return self
    def update(self, payload): self._op, self._payload = "update", payload; return self
    def delete(self): self._op = "delete"; return self
    def eq(self, col, val): self._filters.append(("eq", col, val)); return self
    def in_(self, col, vals): self._filters.append(("in", col, set(vals))); return self
    def order(self, col, desc=False): self._order = (col, desc); return self
    def limit(self, n): self._limit = n; return self

    def _match(self, r):
        for kind, col, val in self._filters:
            if kind == "eq" and r.get(col) != val:
                return False
            if kind == "in" and r.get(col) not in val:
                return False
        return True

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
            kept = [r for r in rows if not self._match(r)]
            gone = [r for r in rows if self._match(r)]
            self._db.tables[self._t] = kept
            return _Res(gone)
        sel = [dict(r) for r in rows if self._match(r)]
        if self._order:
            col, desc = self._order
            sel.sort(key=lambda r: (r.get(col) is None, str(r.get(col))), reverse=desc)
        if self._limit is not None:
            sel = sel[: self._limit]
        return _Res(sel)


class FakeDB:
    def __init__(self, tables: Dict[str, List[Dict[str, Any]]]):
        self.tables = tables
        self._id = 100

    def next_id(self):
        self._id += 1
        return self._id

    def table(self, name: str) -> _Q:
        return _Q(self, name)


def _stock(sym, pools, **kw):
    base = {"symbol": sym, "name": None, "sector": None, "industry": None,
            "exchange": "NSE", "active": True, "pools": list(pools),
            "cap_type_manual": None, "sector_group": None, "metadata": {}}
    base.update(kw)
    return base


@pytest.fixture
def db():
    return FakeDB({
        "pools": [
            {"code": "F40", "name": "Flagship 40", "display_order": 10, "metadata": {}},
            {"code": "E40", "name": "Emerging 40", "display_order": 20, "metadata": {}},
            {"code": "S200", "name": "Smartpick 200", "display_order": 30,
             "metadata": {"screen_criteria": {"normal": {"roce_min": "12"}}}},
        ],
        "stocks": [
            _stock("TCS.NS", ["F40", "S200"], sector="IT", sector_group="Normal"),
            _stock("HELD.NS", ["E40"]),          # journal holds an OPEN trade
            _stock("LONE.NS", ["E40"]),          # nobody references it
        ],
        "journal_trades": [{"symbol": "HELD", "status": "OPEN"}],
        "journal_opportunities": [],
        "universe_syncs": [],
    })


@pytest.fixture
def client(db):
    fastapi = pytest.importorskip("fastapi")  # noqa: F841
    from fastapi.testclient import TestClient
    from plutus.api import create_app
    return TestClient(create_app(supabase_client=db))


def _stock_row(db, sym):
    return next(r for r in db.tables["stocks"] if r["symbol"] == sym)


class TestUniverseRoutes:
    def test_get_universe_shape(self, client):
        r = client.get("/api/universe")
        assert r.status_code == 200
        body = r.json()
        assert body["counts"] == {"F40": 1, "E40": 2, "S200": 1}
        assert body["journal_refs"] == {"HELD": {"open_trades": 1, "active_opps": 0}}
        assert "S200" in body["editable_pools"]

    def test_add_member_creates_stock_and_normalises(self, client, db):
        r = client.post("/api/universe/pools/F40/members",
                        json={"symbol": "infy", "sector": "IT", "cap_type_manual": "Large Cap",
                              "sector_group": "normal"})
        assert r.status_code == 200, r.text
        row = _stock_row(db, "INFY.NS")
        assert row["pools"] == ["F40"] and row["active"] is True
        assert row["cap_type_manual"] == "Large" and row["sector_group"] == "Normal"
        assert row["metadata"]["membership"]["F40"]["source"] == "manual"

    def test_add_member_to_existing_merges_pools(self, client, db):
        r = client.post("/api/universe/pools/E40/members", json={"symbol": "TCS"})
        assert r.status_code == 200
        assert sorted(_stock_row(db, "TCS.NS")["pools"]) == ["E40", "F40", "S200"]
        assert r.json()["already_member"] is False

    def test_bad_cap_is_400(self, client):
        r = client.post("/api/universe/pools/F40/members",
                        json={"symbol": "X", "cap_type_manual": "Huge"})
        assert r.status_code == 400

    def test_remove_last_pool_retires_unless_journal_holds(self, client, db):
        r = client.delete("/api/universe/pools/E40/members/LONE.NS")
        assert r.status_code == 200 and r.json()["retired"] is True
        lone = _stock_row(db, "LONE.NS")
        assert lone["active"] is False and lone["pools"] == []   # row still exists

        r = client.delete("/api/universe/pools/E40/members/HELD")
        assert r.status_code == 200 and r.json()["retired"] is False
        held = _stock_row(db, "HELD.NS")
        assert held["active"] is True and held["pools"] == []

    def test_remove_non_member_404(self, client):
        assert client.delete("/api/universe/pools/F40/members/LONE.NS").status_code == 404

    def test_update_stock_fields(self, client, db):
        r = client.put("/api/universe/stocks/TCS", json={"sector_group": "Banks", "pools": ["X"]})
        assert r.status_code == 200
        row = _stock_row(db, "TCS.NS")
        assert row["sector_group"] == "Banks"
        assert row["pools"] == ["F40", "S200"]     # not whitelisted -> ignored

    def test_import_dry_run_then_apply_replace(self, client, db):
        rows = [{"symbol": "TCS", "sector": "IT"},
                {"symbol": "SBIN", "sector": "Banks", "cap": "Large Cap"},
                {"symbol": "bad symbol"}]
        r = client.post("/api/universe/pools/S200/import",
                        json={"rows": rows, "mode": "replace", "dry_run": True})
        assert r.status_code == 200, r.text
        d = r.json()["diff"]
        assert d["added"] == ["SBIN.NS"] and d["removed"] == [] and d["unchanged"] == 1
        assert d["rejected"][0]["symbol"] == "bad symbol"
        assert db.tables["universe_syncs"] == []           # dry run wrote nothing

        r = client.post("/api/universe/pools/S200/import",
                        json={"rows": rows, "mode": "replace"})
        assert r.status_code == 200, r.text
        sbin = _stock_row(db, "SBIN.NS")
        assert sbin["pools"] == ["S200"] and sbin["sector_group"] == "Banks"
        assert sbin["cap_type_manual"] == "Large"
        syncs = db.tables["universe_syncs"]
        assert len(syncs) == 1 and syncs[0]["status"] == "applied"
        assert syncs[0]["kind"] == "import" and syncs[0]["diff"]["added"] == ["SBIN.NS"]

        # Now the universe reports the sync as the pool's last update.
        body = client.get("/api/universe").json()
        assert body["last_syncs"]["S200"]["mode"] == "replace"

    def test_import_replace_removes_and_retires(self, client, db):
        r = client.post("/api/universe/pools/E40/import",
                        json={"rows": [{"symbol": "NEWCO"}], "mode": "replace"})
        assert r.status_code == 200, r.text
        d = r.json()["diff"]
        assert d["removed"] == ["HELD.NS", "LONE.NS"]
        assert d["kept_for_journal"] == ["HELD.NS"]
        assert _stock_row(db, "LONE.NS")["active"] is False
        assert _stock_row(db, "HELD.NS")["active"] is True
        assert len(db.tables["stocks"]) == 4              # nothing deleted

    def test_import_merge_keeps_members(self, client, db):
        r = client.post("/api/universe/pools/E40/import",
                        json={"rows": [{"symbol": "NEWCO"}], "mode": "merge"})
        assert r.status_code == 200
        assert r.json()["diff"]["removed"] == []
        assert _stock_row(db, "LONE.NS")["active"] is True

    def test_import_rejects_empty(self, client):
        r = client.post("/api/universe/pools/E40/import", json={"rows": [{"symbol": "!!"}]})
        assert r.status_code == 400

    def test_criteria_roundtrip(self, client, db):
        r = client.get("/api/universe/pools/S200/criteria")
        assert r.status_code == 200
        c = r.json()["criteria"]
        assert c["normal"]["roce_min"] == "12"
        assert c["banks_nbfc"]["roe_min"] == "10"          # default fills the gap
        r = client.put("/api/universe/pools/S200/criteria",
                       json={"normal": {"roce_min": "15", "net_profit_min_cr": 250},
                             "banks_nbfc": {"roe_min": "12"}})
        assert r.status_code == 200, r.text
        stored = next(p for p in db.tables["pools"] if p["code"] == "S200")["metadata"]["screen_criteria"]
        assert stored["normal"]["roce_min"] == "15"
        assert stored["normal"]["net_profit_min_cr"] == "250"
        assert stored["banks_nbfc"]["roe_min"] == "12"
        assert stored["banks_nbfc"]["net_profit_min_cr"] == "1000"

    def test_screen_is_explicit_501(self, client):
        r = client.post("/api/universe/pools/S200/screen")
        assert r.status_code == 501
        assert "not wired" in r.json()["error"]

    def test_syncs_listing(self, client, db):
        client.post("/api/universe/pools/E40/import", json={"rows": [{"symbol": "A"}]})
        r = client.get("/api/universe/syncs?pool=E40")
        assert r.status_code == 200 and r.json()["count"] == 1


class TestAuthGate:
    def test_universe_prefix_is_protected(self):
        from plutus.api.auth import is_protected
        assert is_protected("/api/universe")
        assert is_protected("/api/universe/pools/F40/members")


# ---------------------------------------------------------------------------
# Paste flow — symbol parsing, yfinance field mapping, enrich-and-add route
# ---------------------------------------------------------------------------
from plutus.api.universe import (  # noqa: E402
    classify_sector_group,
    fields_from_info,
    parse_symbol_list,
)
from plutus.adapters.result import Result  # noqa: E402


class TestPasteParsing:
    def test_tradingview_export(self):
        syms, rejects = parse_symbol_list("NSE:APTUS,\nNSE:CANFINHOME,\nNSE:CGCL,\n")
        assert syms == ["APTUS.NS", "CANFINHOME.NS", "CGCL.NS"]
        assert rejects == []

    def test_mixed_separators_prefixes_and_dupes(self):
        syms, rejects = parse_symbol_list("tcs, INFY;NSE:TCS BSE:500325 'M&M' bad$sym")
        assert syms == ["TCS.NS", "INFY.NS", "500325.BO", "M&M.NS"]
        assert rejects == ["bad$sym"]

    def test_empty(self):
        assert parse_symbol_list("") == ([], [])
        assert parse_symbol_list(None) == ([], [])


class TestInfoMapping:
    @pytest.mark.parametrize("sector,industry,expected", [
        ("Financial Services", "Banks - Regional", "Banks"),
        ("Financial Services", "Credit Services", "NBFC"),
        ("Financial Services", "Mortgage Finance", "NBFC"),
        ("Financial Services", "Financial Conglomerates", "NBFC"),
        ("Financial Services", "Insurance - Life", "Normal"),
        ("Financial Services", "Asset Management", "Normal"),
        ("Financial Services", "Capital Markets", "Normal"),
        ("Technology", "Information Technology Services", "Normal"),
        (None, None, None),
    ])
    def test_sector_group(self, sector, industry, expected):
        assert classify_sector_group(sector, industry) == expected

    def test_fields_from_info(self):
        f = fields_from_info({
            "longName": "Aptus Value Housing Finance India Limited",
            "sector": "Financial Services", "industry": "Mortgage Finance",
            "marketCap": 125873668096,          # ₹12,587 Cr -> Small
        })
        assert f == {
            "name": "Aptus Value Housing Finance India Limited",
            "sector": "Financial Services", "industry": "Mortgage Finance",
            "cap_type_manual": "Small", "sector_group": "NBFC",
        }

    def test_fields_from_info_partial_and_junk(self):
        assert fields_from_info({"shortName": "X LTD", "marketCap": "abc"}) == {"name": "X LTD"}
        assert fields_from_info(None) == {}
        big = fields_from_info({"marketCap": 11_365_873_876_992})
        assert big == {"cap_type_manual": "Large"}


INFO = {
    "APTUS.NS": {"longName": "Aptus Value Housing Finance India Limited",
                 "sector": "Financial Services", "industry": "Mortgage Finance",
                 "marketCap": 125873668096},
    "HDFCBANK.NS": {"longName": "HDFC Bank Limited", "sector": "Financial Services",
                    "industry": "Banks - Regional", "marketCap": 11365873876992},
}


def fake_fetch_info(symbol: str):
    if symbol in INFO:
        return Result.success(INFO[symbol], symbol=symbol)
    return Result.failure("no data", symbol=symbol)


@pytest.fixture
def paste_client(db):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from plutus.api import create_app
    return TestClient(create_app(supabase_client=db, fetch_info=fake_fetch_info))


class TestPasteRoute:
    def test_dry_run_enriches_without_writing(self, paste_client, db):
        r = paste_client.post("/api/universe/pools/E40/paste",
                              json={"text": "NSE:APTUS,\nNSE:HDFCBANK,\nNSE:NOPE,\nLONE\n", "dry_run": True})
        assert r.status_code == 200, r.text
        b = r.json()
        by = {s["symbol"]: s for s in b["symbols"]}
        assert by["APTUS.NS"]["source"] == "yfinance" and by["APTUS.NS"]["cap_type_manual"] == "Small"
        assert by["APTUS.NS"]["sector_group"] == "NBFC" and by["APTUS.NS"]["known"] is False
        assert by["HDFCBANK.NS"]["sector_group"] == "Banks"
        assert by["NOPE.NS"]["source"] == "failed" and by["NOPE.NS"]["error"] == "no data"
        # LONE is already in E40 and lacks fields -> looked up, fails, stays a member.
        assert by["LONE.NS"]["in_pool"] is True and by["LONE.NS"]["source"] == "failed"
        assert b["fetched"] == 2 and b["failed"] == 2
        assert sorted(b["diff"]["added"]) == ["APTUS.NS", "HDFCBANK.NS", "NOPE.NS"]
        assert b["diff"]["removed"] == []
        assert len(db.tables["stocks"]) == 3 and db.tables["universe_syncs"] == []

    def test_apply_adds_with_fetched_fields(self, paste_client, db):
        r = paste_client.post("/api/universe/pools/E40/paste", json={"text": "NSE:APTUS, NSE:NOPE"})
        assert r.status_code == 200, r.text
        aptus = _stock_row(db, "APTUS.NS")
        assert aptus["pools"] == ["E40"] and aptus["name"].startswith("Aptus")
        assert aptus["cap_type_manual"] == "Small" and aptus["sector_group"] == "NBFC"
        assert aptus["metadata"]["membership"]["E40"]["source"] == "paste"
        nope = _stock_row(db, "NOPE.NS")            # failed lookup still joins the pool
        assert nope["pools"] == ["E40"] and nope.get("name") is None
        syncs = db.tables["universe_syncs"]
        assert len(syncs) == 1 and syncs[0]["criteria"]["source"] == "paste"
        assert syncs[0]["criteria"]["failed"] == 1

    def test_existing_fields_are_not_overwritten_unless_refresh(self, paste_client, db):
        # TCS already has sector 'IT' + group 'Normal'; name is missing so a
        # lookup happens (fails) — the existing values must survive.
        r = paste_client.post("/api/universe/pools/E40/paste", json={"text": "TCS"})
        assert r.status_code == 200, r.text
        tcs = _stock_row(db, "TCS.NS")
        assert tcs["sector"] == "IT" and tcs["sector_group"] == "Normal"
        assert "E40" in tcs["pools"]

    def test_bad_input(self, paste_client):
        assert paste_client.post("/api/universe/pools/E40/paste", json={"text": "!!! ???"}).status_code == 400
        assert paste_client.post("/api/universe/pools/E40/paste",
                                 json={"text": " ".join(f"S{i}" for i in range(301))}).status_code == 400


    def test_replace_mode_removes_and_retires(self, paste_client, db):
        # E40 currently: HELD (journal holds it) + LONE. Paste only APTUS in replace mode.
        r = paste_client.post("/api/universe/pools/E40/paste",
                              json={"text": "NSE:APTUS", "mode": "replace", "dry_run": True})
        assert r.status_code == 200, r.text
        d = r.json()["diff"]
        assert d["added"] == ["APTUS.NS"] and d["removed"] == ["HELD.NS", "LONE.NS"]
        assert d["kept_for_journal"] == ["HELD.NS"]
        assert _stock_row(db, "LONE.NS")["pools"] == ["E40"]     # dry run wrote nothing

        r = paste_client.post("/api/universe/pools/E40/paste", json={"text": "NSE:APTUS", "mode": "replace"})
        assert r.status_code == 200, r.text
        assert _stock_row(db, "APTUS.NS")["pools"] == ["E40"]
        lone = _stock_row(db, "LONE.NS")
        assert lone["pools"] == [] and lone["active"] is False        # retired, not deleted
        held = _stock_row(db, "HELD.NS")
        assert held["pools"] == [] and held["active"] is True         # journal keeps it alive
        assert len(db.tables["stocks"]) == 4
        assert db.tables["universe_syncs"][0]["mode"] == "replace"

    def test_bad_mode(self, paste_client):
        r = paste_client.post("/api/universe/pools/E40/paste", json={"text": "TCS", "mode": "nuke"})
        assert r.status_code == 400
