"""Report wording generated only from run metadata, plus a contradiction check.

Every statement about membership, holdout status, renames and data corrections in report.md
comes from here, so the report cannot say "point-in-time" for a snapshot run, "untouched" for a
previously examined holdout, or "verified" for a curated rename. `contradictions()` is run on
the finished report and the report phase fails if it finds any.
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# membership
# ---------------------------------------------------------------------------

def membership(uni: dict) -> dict:
    kind = uni.get("membership_kind", "snapshot")
    src, as_of = uni.get("source", "unknown source"), uni.get("as_of")
    if kind == "point-in-time":
        return {"kind": kind, "label": "point-in-time (historical)",
                "summary": f"Historical, day-exact membership from {src}" + (f", as of {as_of}" if as_of else "") + ".",
                "bias": "Names are eligible only while they were index members and have prices; members without "
                        "prices are excluded on those days (coverage table below).",
                "limitation": "Membership is historical (point-in-time); remaining bias comes from members without "
                              "prices and from approximated delisting returns, not from the constituent list."}
    if kind == "partial-point-in-time":
        return {"kind": kind, "label": f"historical up to {as_of}, frozen afterwards",
                "summary": f"Historical membership from {src} up to {as_of}; the {as_of} members are assumed unchanged afterwards.",
                "bias": f"Survivorship bias is removed only up to {as_of}; later additions/removals are unknown.",
                "limitation": f"Membership is historical only up to {as_of}; after that a frozen list is used "
                              "(survivorship bias partially present)."}
    return {"kind": "snapshot", "label": "SNAPSHOT (one list for all history)",
            "summary": f"Snapshot list from {src}, applied to every date.",
            "bias": "Survivorship bias and membership look-ahead are NOT removed: names that left the index are "
                    "missing and later additions count as members before they joined. Results are biased upward.",
            "limitation": "Membership is a snapshot list applied to all history (survivorship bias present); "
                          "supply --membership-file with historical intervals to remove it."}


# ---------------------------------------------------------------------------
# holdout
# ---------------------------------------------------------------------------

def holdout(ho: dict, sp: dict, attempts: int) -> dict:
    prior = ho.get("previous_examinations") or []
    examined = ho.get("holdout_status") == "PREVIOUSLY EXAMINED" or bool(prior)
    window = f"{sp['holdout_start']} to {sp['end']}"
    if examined or attempts > 1:
        why = (f"overlaps {len(prior)} earlier evaluation(s) of this target" if prior else
               f"was evaluated {attempts} times in this run")
        return {"status": "previously examined", "examined": True,
                "verdict_suffix": "  [holdout period previously examined — not an untouched test]",
                "headline": f"Holdout = {window}, evaluated once in this run with frozen settings, but the period "
                            f"{why}: it is a re-test, not untouched validation.",
                "chart_title": "NAV per unit, net of costs: development period, then a previously examined holdout",
                "limitation": f"The holdout ({window}) was examined before, so no clean out-of-sample test remains "
                              f"in this data; only data after {sp['end']} can provide one."}
    return {"status": "untouched", "examined": False, "verdict_suffix": "",
            "headline": f"Holdout = {window}, untouched before this run and evaluated once with frozen settings.",
            "chart_title": "NAV per unit, net of costs: development period, then the untouched holdout",
            "limitation": f"Only the holdout ({window}) is a clean test, and it is short."}


# ---------------------------------------------------------------------------
# renames and corrections
# ---------------------------------------------------------------------------

def renames(da: dict) -> str:
    det = da.get("renames_detail")
    if det is None:  # older audits: derive from per-ticker source labels
        det = {x: {"to": y, "basis": "price-verified" if "corr" in (da.get("per_ticker", {}).get(x) or {}).get("source", "")
                   else "curated"} for x, y in (da.get("renames") or {}).items()}
    if not det:
        return "none"
    return ", ".join(f"{x}→{r['to']} ({'price-verified' if r['basis'] == 'price-verified' else 'curated, NOT price-verified'})"
                     for x, r in det.items())


def corrections(da: dict) -> list:
    """Markdown bullet lines for uncertain corrections (empty list if none or not recorded)."""
    unc = da.get("uncertain_corrections")
    if unc is None:
        return ["- Data-correction provenance was not recorded for this run (older engine); treat corrections as unverified."]
    if not unc:
        return ["- All data corrections applied in this run are backed by price evidence."]
    by = {}
    for u in unc:
        by.setdefault(u["kind"], []).append(u["ticker"])
    names = {u["ticker"] for u in unc}
    lines = [f"- **Uncertain data corrections ({len(unc)} corrections on {len(names)} names, not price-verified):**"]
    for k, ts in by.items():
        lines.append(f"  - {k}: {', '.join(sorted(ts))}")
    return lines


def data_sources(da: dict) -> str:
    al = da.get("shared_qlib_alignment") or {}
    measured = sum(1 for p in al.values() if p.get("basis") == "measured")
    shifted = sorted({p["shift"] for p in al.values() if p.get("shift")})
    txt = (f"{da.get('decision', '?')} via Qlib provider {da.get('provider_uri', '?')}, "
           f"{da.get('calendar_start')} to {da.get('calendar_end')}.")
    if al:
        txt += (f" Shared-store date alignment: {measured}/{len(al)} series measured against Yahoo; "
                f"shifts applied: {shifted or 'none'}.")
    return txt


# ---------------------------------------------------------------------------
# contradiction check
# ---------------------------------------------------------------------------

_PATTERNS = {
    "snapshot wording in a historical-membership run": (lambda m: m["kind"] == "point-in-time",
                                                         r"today's constituent list|snapshot list applied to all history|SNAPSHOT \("),
    "historical wording in a snapshot run": (lambda m: m["kind"] == "snapshot",
                                             r"point-in-time \(historical\)|Historical, day-exact membership"),
    "'untouched' claim for an examined holdout": (lambda m: m["examined"],
                                                  r"(?<!not )(?<!no longer )untouched (holdout|before this run)|locked holdout|Only the holdout .* is a clean test"),
    "'previously examined' claim for an untouched holdout": (lambda m: not m["examined"],
                                                            r"previously examined|re-test, not untouched"),
    "curated rename described as verified": (lambda m: True, r"renames? (resolved|detected) by price match"),
}


def contradictions(report: str, uni: dict, ho_desc: dict) -> list:
    meta = {"kind": uni.get("membership_kind", "snapshot"), "examined": ho_desc["examined"]}
    found = []
    for name, (applies, pat) in _PATTERNS.items():
        if applies(meta):
            for m in re.finditer(pat, report):
                line = report[report.rfind("\n", 0, m.start()) + 1: report.find("\n", m.end())]
                found.append(f"{name}: …{line.strip()[:160]}")
    return found
