import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from raui_ai.duplicates import score_pair

class DuplicateTest(unittest.TestCase):
    def setUp(self):
        self.first = {"propertyId": "one", "category": "apartment", "address": "Москва, улица 1", "distanceMeters": 0, "attributes": {"area": 50, "rooms": 2, "floor": 3}, "unit": "12", "photos": ["hash-1"], "sourceReference": "feed:one"}
    def test_multiple_signals_produce_reasons_not_a_merge(self):
        result = score_pair(self.first, {**self.first, "propertyId": "two"})
        self.assertGreaterEqual(result["confidence"], .7)
        self.assertIn("address", result["reasons"])
        self.assertIn("photo", result["reasons"])
        self.assertFalse(result["autoMerge"])
        self.assertTrue(result["requiresHumanReview"])
    def test_one_weak_signal_and_different_units_are_not_conclusive(self):
        result = score_pair(self.first, {"propertyId": "two", "category": "apartment", "address": "Москва, улица 1", "distanceMeters": 1000, "unit": "13", "attributes": {"area": 200}})
        self.assertLess(result["confidence"], .5)
        self.assertIn("unit_conflict", result["reasons"])
        self.assertFalse(result["autoMerge"])
    def test_shared_physical_identity_is_not_a_license_to_merge_offers(self):
        result = score_pair(self.first, {**self.first, "unit": "13"})
        self.assertIn("shared_property", result["reasons"])
        self.assertFalse(result["autoMerge"])
    def test_unknown_or_malformed_facts_do_not_become_positive_signals(self):
        result = score_pair({"category": "apartment"}, {"category": "house"})
        self.assertEqual(result["confidence"], 0)
        self.assertEqual(result["reasons"], [])
