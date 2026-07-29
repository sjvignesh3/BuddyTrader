"""
Universe loader - parses the Master CSV and extracts stock pools.
"""
import csv
from typing import Dict, List
from ..core.config import MASTER_CSV_PATH


def load_universe() -> List[Dict]:
    """
    Parse the Master CSV and return a list of stock dicts.
    Each dict: {symbol, sector, pool_code, pool_name, cap_type}
    """
    stocks = []
    with open(MASTER_CSV_PATH, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)  # Skip header row

        for row in reader:
            if len(row) < 6:
                continue
            symbol = row[0].strip()
            sector = row[1].strip()
            pool_code = row[2].strip()
            pool_name = row[3].strip()
            cap_type = row[5].strip() if len(row) > 5 else ""

            if not symbol or not pool_code:
                continue

            stocks.append({
                "symbol": symbol,
                "sector": sector,
                "pool_code": pool_code,
                "pool_name": pool_name,
                "cap_type": cap_type,
            })

    return stocks


def get_pool_stocks(pool_code: str) -> List[Dict]:
    """Get stocks belonging to a specific pool (F40, E40, S200).
    Pass pool_code="ALL" to return the entire universe — used by PlayArea
    to enrich custom symbols with sector / cap_type from the master CSV.
    """
    all_stocks = load_universe()
    if pool_code == "ALL":
        return all_stocks
    return [s for s in all_stocks if s["pool_code"] == pool_code]


def get_f40_symbols() -> List[str]:
    """Get just the symbols for F40 pool."""
    return [s["symbol"] for s in get_pool_stocks("F40")]


def get_all_pools_summary() -> Dict:
    """Get a summary of all pools and their stock counts."""
    all_stocks = load_universe()
    pools = {}
    for s in all_stocks:
        code = s["pool_code"]
        if code not in pools:
            pools[code] = {"name": s["pool_name"], "count": 0, "stocks": []}
        pools[code]["count"] += 1
        pools[code]["stocks"].append(s["symbol"])
    return pools
