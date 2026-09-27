import importlib.util
import json
import math
import unittest
from datetime import datetime, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("extract_cscl.py")
SPEC = importlib.util.spec_from_file_location("extract_cscl", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ExtractCsclTest(unittest.TestCase):
    def test_canonical_json_serializes_official_dates_as_utc_iso_strings(self):
        value = {"modified": datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)}
        self.assertEqual(
            json.loads(MODULE.canonical_json(value)),
            {"modified": "2026-09-27T12:00:00+00:00"},
        )

    def test_canonical_json_converts_missing_table_values_to_json_null(self):
        encoded = MODULE.canonical_json({"missing": math.nan})
        self.assertEqual(encoded, '{"missing":null}')
        self.assertEqual(json.loads(encoded), {"missing": None})

    def test_iter_records_supports_non_spatial_official_tables(self):
        class TabularFrame:
            def to_dict(self, *, orient):
                self.orient = orient
                return [{"B7SC": "11267001"}]

        frame = TabularFrame()
        self.assertEqual(
            list(MODULE.iter_records(frame)),
            [{"B7SC": "11267001"}],
        )
        self.assertEqual(frame.orient, "records")


if __name__ == "__main__":
    unittest.main()
