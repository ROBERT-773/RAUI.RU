"""Versioned, conservative evidence scoring; never merges physical objects or offers."""
import math
import re

RULE_VERSION = "trust-v1"

def _address(value):
    return re.sub(r"\W+", " ", str(value or "").casefold()).strip()

def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def score_pair(first, second):
    reasons, score = [], 0.0
    if first.get("category") != second.get("category"):
        return {"confidence": 0, "reasons": [], "autoMerge": False, "requiresHumanReview": True, "ruleVersion": RULE_VERSION}
    if first.get("propertyId") and first.get("propertyId") == second.get("propertyId"):
        reasons.append("shared_property")
        score = .9
    if _address(first.get("address")) and _address(first.get("address")) == _address(second.get("address")):
        reasons.append("address")
        score += .15
    distance = second.get("distanceMeters")
    if _number(distance) and 0 <= distance <= 30:
        reasons.append("geo")
        score += .15
    a, b = first.get("attributes", {}), second.get("attributes", {})
    if _number(a.get("area")) and _number(b.get("area")) and a["area"] > 0 and abs(a["area"] - b["area"]) / a["area"] <= .03:
        reasons.append("area")
        score += .2
    if any(_number(a.get(key)) and a.get(key) == b.get(key) for key in ("rooms", "floor")):
        reasons.append("layout")
        score += .1
    if set(first.get("photos", [])) & set(second.get("photos", [])):
        reasons.append("photo")
        score += .25
    if first.get("sourceReference") and first.get("sourceReference") == second.get("sourceReference"):
        reasons.append("source")
        score += .25
    if first.get("unit") and second.get("unit") and first["unit"] != second["unit"]:
        reasons.append("unit_conflict")
        score = min(score, .25)
    return {"confidence": round(min(score, .99), 2), "reasons": reasons, "autoMerge": False, "requiresHumanReview": True, "ruleVersion": RULE_VERSION}
