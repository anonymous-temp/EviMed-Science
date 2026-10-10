"""Public probes cannot silently discard or qualify credentialed fixtures."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_connector_audit as audit


class ConnectorFixtureClassification(unittest.TestCase):
    def test_iuphar_remains_a_conditional_fixture_and_is_not_public(self):
        server = audit.load_server()
        sources = server.public_sources
        identifier = "iuphar-bps-guide-to-pharmacology"
        self.assertNotIn(identifier, sources.BIOMEDICAL_SOURCE_IDS)
        self.assertIn(identifier, sources.CONDITIONAL_BIOMEDICAL_SOURCE_IDS)
        self.assertIn(identifier, audit.QUERY_CASES)
        self.assertEqual(audit.validate_query_cases(sources.BIOMEDICAL_SOURCE_IDS,
                                                  sources.CONDITIONAL_BIOMEDICAL_SOURCE_IDS), [identifier])
        row = next(row for row in server.source_catalog.sources() if row["id"] == identifier)
        self.assertEqual(row["connectionState"], "ready_credentials")
        self.assertEqual(row["validation"]["liveProbe"], "blocked_missing_credential")

    def test_missing_public_fixture_is_refused(self):
        with patch.dict(audit.QUERY_CASES, {"public": ("a", "b")}, clear=True):
            with self.assertRaises(SystemExit):
                audit.validate_query_cases(["public", "uncovered"], [])

    def test_unclassified_historical_fixture_is_refused(self):
        with patch.dict(audit.QUERY_CASES, {"public": ("a", "b"), "unknown": ("c", "d")}, clear=True):
            with self.assertRaises(SystemExit):
                audit.validate_query_cases(["public"], [])

    def test_a_conditional_connector_cannot_also_be_counted_as_public(self):
        with patch.dict(audit.QUERY_CASES, {"conditional": ("a", "b")}, clear=True):
            with self.assertRaises(SystemExit):
                audit.validate_query_cases(["conditional"], ["conditional"])

    def test_catalog_cannot_call_the_unauthorized_iuphar_connector_connected_public(self):
        audit.load_server()
        import verify_release_audit as release
        real_load = release.load_module

        def load(name, path):
            module = real_load(name, path)
            if Path(path).name == "source_catalog.py":
                original = module.active_connector_ids
                module.active_connector_ids = lambda: (*original(), "iuphar-bps-guide-to-pharmacology")
            return module

        with patch.object(release, "load_module", side_effect=load):
            with self.assertRaisesRegex(SystemExit, "catalogued public connectors do not exactly match"):
                release.verify_sources()


if __name__ == "__main__":
    unittest.main()
