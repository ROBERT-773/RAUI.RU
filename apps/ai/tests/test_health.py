import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from raui_ai import health

class HealthTest(unittest.TestCase):
    def test_health(self):
        self.assertEqual(health(), {"status": "ok", "service": "ai"})
