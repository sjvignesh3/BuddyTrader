"""
Screener Engine — Data-driven fundamental screener with SOLID rule evaluation.

ARCHITECTURE:
  - Each filter criterion is defined as a RULE CONFIG dict.
  - Rules are evaluated only if enabled.
  - New filters are added by appending a config object — no code changes needed.
  - Business logic is independent from UI: rules are pure functions.

RULE CONFIG SCHEMA:
  {
    "id":           str,       # unique rule identifier
    "category":     str,       # group: "ath", "valuation", "quality", "promoter"
    "label":        str,       # human-readable name
    "description":  str,       # tooltip / help text
    "enabled":      bool,      # default enable/disable
    "params": {                # user-editable parameters with defaults
      "param_name": {
        "label":   str,
        "type":    "float" | "int",
        "default": number,
        "min":     number,
        "max":     number,
        "unit":    str         # e.g. "%", "years", "quarters"
      }
    },
    "evaluator":    str        # name of the evaluation function
  }

EVALUATION FUNCTIONS:
  Each evaluator receives (fundamental_data, params) -> {passed: bool, details: {}}
"""
import logging
import copy
from typing import Dict, List, Optional, Any, Callable

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
#  RULE DEFINITIONS — ADD NEW FILTERS HERE
# ═══════════════════════════════════════════════════════════════════════════

DEFAULT_SCREENER_RULES = [
    # ── Fundamental ATH Filters ──────────────────────────────────────────
    {
        "id": "sales_ath",
        "category": "ath",
        "label": "Sales at All-Time High",
        "description": "Latest quarterly Sales must be >= historical ATH Sales × (1 - tolerance%). Ensures the company's revenue is at or near its peak.",
        "enabled": True,
        "params": {
            "tolerance_pct": {
                "label": "Tolerance",
                "type": "float",
                "default": 2.0,
                "min": 0,
                "max": 20,
                "unit": "%"
            }
        },
        "evaluator": "eval_ath_metric",
        "metric_key": "sales",
    },
    {
        "id": "pbt_ath",
        "category": "ath",
        "label": "Profit Before Tax at ATH",
        "description": "Latest quarterly Profit Before Tax must be >= historical ATH PBT × (1 - tolerance%). Ensures pre-tax profitability is near its peak.",
        "enabled": True,
        "params": {
            "tolerance_pct": {
                "label": "Tolerance",
                "type": "float",
                "default": 2.0,
                "min": 0,
                "max": 20,
                "unit": "%"
            }
        },
        "evaluator": "eval_ath_metric",
        "metric_key": "pbt",
    },
    {
        "id": "net_profit_ath",
        "category": "ath",
        "label": "Net Profit at ATH",
        "description": "Latest quarterly Net Profit must be >= historical ATH Net Profit × (1 - tolerance%). Ensures bottom-line profitability is near its peak.",
        "enabled": True,
        "params": {
            "tolerance_pct": {
                "label": "Tolerance",
                "type": "float",
                "default": 2.0,
                "min": 0,
                "max": 20,
                "unit": "%"
            }
        },
        "evaluator": "eval_ath_metric",
        "metric_key": "net_profit",
    },
    # ── Valuation Filters ────────────────────────────────────────────────
    {
        "id": "pe_below_avg",
        "category": "valuation",
        "label": "PE < Historical Average PE",
        "description": "Current PE ratio must be less than the average PE of the previous N years. Identifies stocks trading below their historical valuation.",
        "enabled": True,
        "params": {
            "lookback_years": {
                "label": "Lookback Years",
                "type": "int",
                "default": 5,
                "min": 1,
                "max": 10,
                "unit": "years"
            }
        },
        "evaluator": "eval_pe_below_avg",
    },
    {
        "id": "pb_below_avg",
        "category": "valuation",
        "label": "PB < Historical Average PB",
        "description": "Current Price-to-Book ratio must be less than the average PB of the previous N years. Identifies stocks trading below their historical book value multiple.",
        "enabled": True,
        "params": {
            "lookback_years": {
                "label": "Lookback Years",
                "type": "int",
                "default": 5,
                "min": 1,
                "max": 10,
                "unit": "years"
            }
        },
        "evaluator": "eval_pb_below_avg",
    },

    {
        "id": "net_debt_to_equity_max",
        "category": "valuation",
        "label": "Net Debt to Equity",
        "description": "Net Debt to Equity ratio must be less than the threshold. Lower ratio means the company is less leveraged and financially healthier.",
        "enabled": True,
        "params": {
            "max_value": {
                "label": "Max Ratio",
                "type": "float",
                "default": 0.30,
                "min": -10,
                "max": 20,
                "unit": "x"
            }
        },
        "evaluator": "eval_net_debt_to_equity",
    },

    # ── Quality Filters ──────────────────────────────────────────────────
    {
        "id": "roce_min",
        "category": "quality",
        "label": "ROCE",
        "description": "Return on Capital Employed must be >= threshold. Measures how efficiently the company uses its capital to generate profits.",
        "enabled": True,
        "params": {
            "min_value": {
                "label": "Minimum ROCE",
                "type": "float",
                "default": 18.0,
                "min": 0,
                "max": 100,
                "unit": "%"
            }
        },
        "evaluator": "eval_quality_metric",
        "metric_key": "roce",
        "operator": ">=",
    },
    {
        "id": "roe_min",
        "category": "quality",
        "label": "ROE",
        "description": "Return on Equity must be >= threshold. Measures profitability relative to shareholders' equity.",
        "enabled": True,
        "params": {
            "min_value": {
                "label": "Minimum ROE",
                "type": "float",
                "default": 18.0,
                "min": 0,
                "max": 100,
                "unit": "%"
            }
        },
        "evaluator": "eval_quality_metric",
        "metric_key": "roe",
        "operator": ">=",
    },

    # ── Promoter Filters ─────────────────────────────────────────────────
    {
        "id": "pledging_max",
        "category": "promoter",
        "label": "Maximum Promoter Pledging",
        "description": "Promoter pledging percentage must be <= threshold. High pledging indicates promoters have borrowed against their shares — a risk signal.",
        "enabled": True,
        "params": {
            "max_value": {
                "label": "Max Pledging",
                "type": "float",
                "default": 5.0,
                "min": 0,
                "max": 100,
                "unit": "%"
            }
        },
        "evaluator": "eval_pledging",
    },
]


# ═══════════════════════════════════════════════════════════════════════════
#  EVALUATOR FUNCTIONS — PURE BUSINESS LOGIC
# ═══════════════════════════════════════════════════════════════════════════

def eval_ath_metric(fundamental_data: Dict, rule: Dict, params: Dict) -> Dict:
    """
    Evaluate if a metric (sales/pbt/net_profit) is at or near ATH.

    IMPORTANT: Compares quarterly values against quarterly ATH only.
    Annual totals are NOT mixed in — quarterly ~72K vs annual ~275K
    would be an apple-to-oranges comparison.
    """
    metric_key = rule.get("metric_key", "sales")
    tolerance = params.get("tolerance_pct", 2.0)

    quarterly = fundamental_data.get("quarterly_results", [])

    # Get all quarterly values for this metric (same granularity comparison)
    q_values = []
    for q in quarterly:
        val = q.get(metric_key)
        if val is not None:
            q_values.append(val)

    if not q_values:
        return {
            "passed": False,
            "reason": f"No quarterly {metric_key} data available",
            "latest_value": None,
            "ath_value": None,
        }

    # Latest quarterly value
    latest = None
    for q in reversed(quarterly):
        val = q.get(metric_key)
        if val is not None:
            latest = val
            break

    if latest is None:
        return {
            "passed": False,
            "reason": f"No latest quarterly {metric_key} data",
            "latest_value": None,
            "ath_value": None,
        }

    ath_value = max(q_values)
    threshold = ath_value * (1 - tolerance / 100.0)
    passed = latest >= threshold

    return {
        "passed": passed,
        "reason": (
            f"Latest Q {metric_key}: {latest:.1f}, Q-ATH: {ath_value:.1f}, "
            f"Threshold (ATH × {100-tolerance:.0f}%): {threshold:.1f}"
        ),
        "latest_value": latest,
        "ath_value": ath_value,
        "threshold": round(threshold, 2),
    }


def eval_ath_match_quarters(fundamental_data: Dict, rule: Dict, params: Dict) -> Dict:
    """
    Check that ATH conditions hold for each of the last N quarters.
    This re-evaluates the ATH rules for each of the N most recent quarters.
    Uses quarterly-only ATH values (not annual) for apples-to-apples comparison.
    """
    num_quarters = params.get("num_quarters", 2)
    quarterly = fundamental_data.get("quarterly_results", [])

    if len(quarterly) < num_quarters:
        return {
            "passed": False,
            "reason": f"Only {len(quarterly)} quarters available, need {num_quarters}",
            "quarters_checked": len(quarterly),
            "quarters_passed": 0,
        }

    # Get quarterly ATH for each metric (same granularity only)
    q_metrics = {"sales": [], "pbt": [], "net_profit": []}
    for q in quarterly:
        for key in q_metrics:
            val = q.get(key)
            if val is not None:
                q_metrics[key].append(val)

    # Use a default tolerance of 2% for the multi-quarter check
    tolerance = 2.0

    # Check the last N quarters
    recent_quarters = quarterly[-num_quarters:] if len(quarterly) >= num_quarters else quarterly
    quarters_passed = 0
    failed_details = []

    for q in recent_quarters:
        q_passed = True
        for metric_key in ["sales", "pbt", "net_profit"]:
            val = q.get(metric_key)
            if val is None:
                continue
            all_vals = q_metrics.get(metric_key, [])
            if not all_vals:
                continue
            ath = max(all_vals)
            threshold = ath * (1 - tolerance / 100.0)
            if val < threshold:
                q_passed = False
                failed_details.append(
                    f"{q.get('quarter', '?')}: {metric_key}={val:.1f} < threshold={threshold:.1f}"
                )
        if q_passed:
            quarters_passed += 1

    passed = quarters_passed >= num_quarters

    return {
        "passed": passed,
        "reason": (
            f"{quarters_passed}/{num_quarters} quarters meet Q-ATH criteria"
            + (f". Failures: {'; '.join(failed_details[:3])}" if failed_details else "")
        ),
        "quarters_checked": num_quarters,
        "quarters_passed": quarters_passed,
    }


def eval_pe_below_avg(fundamental_data: Dict, rule: Dict, params: Dict) -> Dict:
    """
    Evaluate if current PE is below its N-year historical average.

    SOURCE CONSISTENCY RULE:
    ─────────────────────────────────────────────────────────────────────────
    Current PE and the 5yr average PE MUST come from the same source.
    Screener page → Stock P/E (TTM-based, live)
    Quick-ratio   → 5Yrs PE  (5yr average of TTM PE, same methodology)

    The chart API uses a different PE calculation (closing price / adjusted EPS)
    that does NOT match the TTM-based quick-ratio average. Using chart current PE
    with page 5yr avg (or vice versa) produces wrong PASS/FAIL outcomes.

    Priority:
      1. ratios["current_pe"]  — page TTM PE (set from screener page in fetcher)
      2. valuation["current_pe"] — chart API fallback (only if page unavailable)
    """
    lookback_years = int(params.get("lookback_years", 5))
    ratios = fundamental_data.get("ratios", {})
    valuation = fundamental_data.get("valuation", {})

    # Prefer page-sourced TTM PE; fall back to chart only if page value missing
    current_pe = ratios.get("current_pe")
    if current_pe is None:
        current_pe = valuation.get("current_pe")

    if current_pe is None:
        return {
            "passed": False,
            "reason": "Current PE not available (company ID not found on screener.in)",
            "current_pe": None,
            "avg_pe": None,
        }

    # Pre-computed scalar stored in valuation (page quick-ratio wins over chart-computed avg).
    # pe_series is NOT stored in the persistent cache — averages are computed at fetch time
    # and only the scalar results are persisted. If avg_pe is None here it means the data
    # was genuinely unavailable during the original fetch (not enough history).
    avg_key = f"pe_avg_{lookback_years}yr"
    avg_pe = valuation.get(avg_key)

    if avg_pe is None:
        return {
            "passed": False,
            "reason": (
                f"Insufficient PE history for {lookback_years}yr average. "
                f"Current PE: {current_pe:.1f}"
            ),
            "current_pe": round(current_pe, 2),
            "avg_pe": None,
        }

    passed = current_pe < avg_pe
    return {
        "passed": passed,
        "reason": f"Current PE: {current_pe:.1f} vs {lookback_years}yr Avg: {avg_pe:.1f}",
        "current_pe": round(current_pe, 2),
        "avg_pe": avg_pe,
    }


def eval_pb_below_avg(fundamental_data: Dict, rule: Dict, params: Dict) -> Dict:
    """
    Evaluate if current PB is below its N-year historical average.

    SOURCE CONSISTENCY RULE:
    ─────────────────────────────────────────────────────────────────────────
    Current PB and the 5yr average PB MUST come from the same source.
    Screener page → Price / Book Value (TTM-based, live)
    Quick-ratio   → 5Yrs PBV  (5yr average of TTM PBV, same methodology)

    Priority:
      1. ratios["current_pb"]  — page TTM PB (computed from Current Price / Book Value)
      2. valuation["current_pb"] — chart API fallback (only if page unavailable)
    """
    lookback_years = int(params.get("lookback_years", 5))
    ratios = fundamental_data.get("ratios", {})
    valuation = fundamental_data.get("valuation", {})

    # Prefer page-sourced TTM PB; fall back to chart only if page value missing
    current_pb = ratios.get("current_pb")
    if current_pb is None:
        current_pb = valuation.get("current_pb")

    if current_pb is None:
        return {
            "passed": False,
            "reason": "Current PB not available (company ID not found on screener.in)",
            "current_pb": None,
            "avg_pb": None,
        }

    # Pre-computed scalar stored in valuation (page quick-ratio wins over chart-computed avg).
    # pb_series is NOT stored in the persistent cache — averages are computed at fetch time
    # and only the scalar results are persisted. If avg_pb is None here it means the data
    # was genuinely unavailable during the original fetch (not enough history).
    avg_key = f"pb_avg_{lookback_years}yr"
    avg_pb = valuation.get(avg_key)

    if avg_pb is None:
        return {
            "passed": False,
            "reason": (
                f"Insufficient PB history for {lookback_years}yr average. "
                f"Current PB: {current_pb:.1f}"
            ),
            "current_pb": round(current_pb, 2),
            "avg_pb": None,
        }

    passed = current_pb < avg_pb
    return {
        "passed": passed,
        "reason": f"Current PB: {current_pb:.1f} vs {lookback_years}yr Avg: {avg_pb:.1f}",
        "current_pb": round(current_pb, 2),
        "avg_pb": avg_pb,
    }


def eval_quality_metric(fundamental_data: Dict, rule: Dict, params: Dict) -> Dict:
    """Evaluate ROCE or ROE against a threshold."""
    metric_key = rule.get("metric_key", "roce")
    operator = rule.get("operator", ">=")
    min_value = params.get("min_value", 18.0)

    ratios = fundamental_data.get("ratios", {})
    current_value = ratios.get(metric_key)

    if current_value is None:
        return {
            "passed": False,
            "reason": f"{metric_key.upper()} not available",
            "value": None,
            "threshold": min_value,
        }

    if operator == ">=":
        passed = current_value >= min_value
    elif operator == "<=":
        passed = current_value <= min_value
    elif operator == ">":
        passed = current_value > min_value
    elif operator == "<":
        passed = current_value < min_value
    else:
        passed = current_value >= min_value

    return {
        "passed": passed,
        "reason": f"{metric_key.upper()}: {current_value:.1f}% (threshold: {operator} {min_value:.1f}%)",
        "value": round(current_value, 2),
        "threshold": min_value,
    }


def eval_pledging(fundamental_data: Dict, rule: Dict, params: Dict) -> Dict:
    """Evaluate promoter pledging percentage."""
    max_value = params.get("max_value", 5.0)
    shareholding = fundamental_data.get("shareholding", {})
    pledging = shareholding.get("promoter_pledging_pct")

    # None means data was not found/parsed — do NOT assume 0.
    # Screener.in shows explicit pledging rows even when 0%.
    # A None here means the page didn't load or the row was absent.
    if pledging is None:
        return {
            "passed": False,
            "reason": "Pledging data not found — cannot verify (treated as fail for safety)",
            "value": None,
            "threshold": max_value,
        }

    passed = pledging <= max_value

    return {
        "passed": passed,
        "reason": f"Promoter Pledging: {pledging:.1f}% (max allowed: {max_value:.1f}%)",
        "value": round(pledging, 2),
        "threshold": max_value,
    }


def eval_net_debt_to_equity(fundamental_data: Dict, rule: Dict, params: Dict) -> Dict:
    """
    Evaluate Net Debt to Equity ratio.
    Fetched from screener.in's key ratios section (authenticated page).
    """
    max_value = params.get("max_value", 0.30)
    ratios = fundamental_data.get("ratios", {})
    net_debt_to_equity = ratios.get("net_debt_to_equity")

    if net_debt_to_equity is None:
        return {
            "passed": False,
            "reason": "Net Debt to Equity not available (requires authenticated data)",
            "value": None,
            "threshold": max_value,
        }

    passed = net_debt_to_equity < max_value

    return {
        "passed": passed,
        "reason": (
            f"Net Debt/Equity: {net_debt_to_equity:.2f} "
            f"(threshold: < {max_value:.2f})"
        ),
        "value": round(net_debt_to_equity, 2),
        "threshold": max_value,
    }


# ═══════════════════════════════════════════════════════════════════════════
#  EVALUATOR REGISTRY
# ═══════════════════════════════════════════════════════════════════════════

EVALUATOR_REGISTRY: Dict[str, Callable] = {
    "eval_ath_metric":           eval_ath_metric,
    "eval_ath_match_quarters":   eval_ath_match_quarters,
    "eval_pe_below_avg":         eval_pe_below_avg,
    "eval_pb_below_avg":         eval_pb_below_avg,
    "eval_quality_metric":       eval_quality_metric,
    "eval_pledging":             eval_pledging,
    "eval_net_debt_to_equity":   eval_net_debt_to_equity,
}


# ═══════════════════════════════════════════════════════════════════════════
#  SCREENER ORCHESTRATOR
# ═══════════════════════════════════════════════════════════════════════════

def get_default_rules() -> List[Dict]:
    """Return a deep copy of the default screener rule configs."""
    return copy.deepcopy(DEFAULT_SCREENER_RULES)


def evaluate_stock(fundamental_data: Dict, rules: List[Dict]) -> Dict:
    """
    Evaluate a single stock against all enabled screening rules.

    Args:
        fundamental_data: Parsed fundamental data from screener_data_fetcher
        rules: List of rule config dicts (with user-modified enabled/params)

    Returns:
        {
            "symbol": str,
            "all_passed": bool,
            "total_rules": int,
            "passed_count": int,
            "failed_count": int,
            "skipped_count": int,
            "rule_results": [
                {
                    "rule_id": str,
                    "rule_label": str,
                    "category": str,
                    "enabled": bool,
                    "passed": bool | None,
                    "details": {...}
                }
            ],
            "fundamentals_summary": {...}
        }
    """
    symbol = fundamental_data.get("symbol", "?")
    rule_results = []
    passed_count = 0
    failed_count = 0
    skipped_count = 0

    for rule in rules:
        rule_id = rule["id"]
        enabled = rule.get("enabled", True)

        if not enabled:
            rule_results.append({
                "rule_id": rule_id,
                "rule_label": rule["label"],
                "category": rule["category"],
                "enabled": False,
                "passed": None,
                "details": {"reason": "Rule disabled — skipped"},
            })
            skipped_count += 1
            continue

        evaluator_name = rule.get("evaluator", "")
        evaluator_fn = EVALUATOR_REGISTRY.get(evaluator_name)

        if not evaluator_fn:
            logger.warning(f"Unknown evaluator '{evaluator_name}' for rule '{rule_id}'")
            rule_results.append({
                "rule_id": rule_id,
                "rule_label": rule["label"],
                "category": rule["category"],
                "enabled": True,
                "passed": None,
                "details": {"reason": f"Unknown evaluator: {evaluator_name}"},
            })
            skipped_count += 1
            continue

        # Build effective params: merge defaults with user overrides
        effective_params = {}
        for param_key, param_def in rule.get("params", {}).items():
            effective_params[param_key] = param_def.get("value", param_def.get("default"))

        try:
            result = evaluator_fn(fundamental_data, rule, effective_params)
            passed = result.get("passed", False)

            rule_results.append({
                "rule_id": rule_id,
                "rule_label": rule["label"],
                "category": rule["category"],
                "enabled": True,
                "passed": passed,
                "details": result,
            })

            if passed:
                passed_count += 1
            else:
                failed_count += 1

        except Exception as e:
            logger.error(f"Error evaluating rule '{rule_id}' for {symbol}: {e}")
            rule_results.append({
                "rule_id": rule_id,
                "rule_label": rule["label"],
                "category": rule["category"],
                "enabled": True,
                "passed": False,
                "details": {"reason": f"Evaluation error: {str(e)}"},
            })
            failed_count += 1

    total_enabled = passed_count + failed_count
    all_passed = (total_enabled > 0 and failed_count == 0)

    # Build a summary of key fundamentals for display
    ratios = fundamental_data.get("ratios", {})
    shareholding = fundamental_data.get("shareholding", {})
    quarterly = fundamental_data.get("quarterly_results", [])

    # Latest quarter values
    latest_q = quarterly[-1] if quarterly else {}

    fundamentals_summary = {
        "current_pe": ratios.get("current_pe"),
        "current_pb": ratios.get("current_pb"),
        "roce": ratios.get("roce"),
        "roe": ratios.get("roe"),
        "promoter_pledging_pct": shareholding.get("promoter_pledging_pct"),
        "net_debt_to_equity": ratios.get("net_debt_to_equity"),
        "latest_sales": latest_q.get("sales"),
        "latest_pbt": latest_q.get("pbt"),
        "latest_net_profit": latest_q.get("net_profit"),
    }

    return {
        "symbol": symbol,
        "all_passed": all_passed,
        "total_rules": len(rules),
        "passed_count": passed_count,
        "failed_count": failed_count,
        "skipped_count": skipped_count,
        "rule_results": rule_results,
        "fundamentals_summary": fundamentals_summary,
    }


def run_screener(
    symbols: List[str],
    rules: List[Dict],
    fundamental_data_map: Dict[str, Dict],
    stock_info_map: Optional[Dict[str, Dict]] = None,
) -> List[Dict]:
    """
    Run the screener against multiple stocks.

    Args:
        symbols: List of stock symbols to screen
        rules: List of rule config dicts (with user params)
        fundamental_data_map: {symbol: fundamental_data} from data fetcher
        stock_info_map: Optional {symbol: {sector, cap_type, ...}} for enrichment

    Returns:
        List of stock results, sorted by passed_count descending.
    """
    results = []

    for symbol in symbols:
        fdata = fundamental_data_map.get(symbol)
        if not fdata:
            results.append({
                "symbol": symbol,
                "sector": (stock_info_map or {}).get(symbol, {}).get("sector", ""),
                "cap_type": (stock_info_map or {}).get(symbol, {}).get("cap_type", ""),
                "all_passed": False,
                "total_rules": len(rules),
                "passed_count": 0,
                "failed_count": 0,
                "skipped_count": len(rules),
                "rule_results": [],
                "fundamentals_summary": {},
                "error": "Fundamental data not available",
            })
            continue

        stock_result = evaluate_stock(fdata, rules)

        # Enrich with pool info
        sinfo = (stock_info_map or {}).get(symbol, {})
        stock_result["sector"] = sinfo.get("sector", "")
        stock_result["cap_type"] = sinfo.get("cap_type", "")

        results.append(stock_result)

    # Sort: all_passed first, then by passed_count descending
    results.sort(key=lambda x: (
        not x.get("all_passed", False),
        -(x.get("passed_count", 0)),
    ))

    return results
