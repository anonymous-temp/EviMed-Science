import importlib
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
science_connectors = importlib.import_module("science_connectors")


class ScienceConnectorDispatchTests(unittest.TestCase):
    def assert_json_connector(self, connector, arguments, expected_host, payload=None):
        payload = payload if payload is not None else {"ok": True}
        with mock.patch.object(science_connectors.public_sources, "_get_json_value", return_value=payload) as request:
            result = science_connectors.direct_query(connector, arguments)
        self.assertIn(expected_host, result["source"])
        self.assertEqual(result["data"], payload)
        request.assert_called_once()

    def test_paper_search_uses_crossref(self):
        self.assert_json_connector("paper-search", {"query": "causal inference", "limit": 5}, "api.crossref.org")

    def test_biomcp_routes_clinical_trials_to_the_official_v2_api(self):
        self.assert_json_connector(
            "biomcp",
            {"query": "sepsis", "database": "clinicaltrials", "limit": 4},
            "clinicaltrials.gov/api/v2/studies",
        )

    def test_biomcp_routes_pubmed_through_the_ncbi_policy_throttle(self):
        with mock.patch.object(science_connectors.public_sources, "_ncbi_get_json", return_value={"ok": True}) as request:
            result = science_connectors.direct_query("biomcp", {"query": "sepsis", "database": "pubmed", "limit": 4})
        self.assertIn("eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", result["source"])
        self.assertEqual(result["data"], {"ok": True})
        request.assert_called_once()

    def test_materials_project_uses_the_summary_api(self):
        self.assert_json_connector(
            "materials-project",
            {"material_id": "mp-149", "limit": 1},
            "api.materialsproject.org/materials/summary",
        )

    def test_fred_uses_the_public_csv_series_endpoint(self):
        with mock.patch.object(science_connectors.public_sources, "_get_text", return_value="DATE,GDP\n2025-01-01,1\n"):
            result = science_connectors.direct_query("fred", {"series_id": "GDP", "limit": 1})
        self.assertIn("fred.stlouisfed.org/graph/fredgraph.csv", result["source"])
        self.assertEqual(result["data"], ["DATE,GDP", "2025-01-01,1"])

    def test_space_weather_uses_noaa_alerts(self):
        self.assert_json_connector("spaceweather", {"limit": 2}, "services.swpc.noaa.gov", [{"message": "alert"}])

    def test_open_meteo_bounds_forecast_coordinates(self):
        self.assert_json_connector(
            "open-meteo",
            {"latitude": 31.2, "longitude": 121.5, "forecast_days": 3},
            "api.open-meteo.com/v1/forecast",
        )

    def test_usgs_water_rejects_non_numeric_sites_and_uses_nwis(self):
        with self.assertRaisesRegex(ValueError, "site_invalid"):
            science_connectors.direct_query("usgs-water", {"site": "../../secret"})
        self.assert_json_connector(
            "usgs-water",
            {"site": "01646500", "period": "P3D"},
            "waterservices.usgs.gov/nwis/iv",
        )

    def test_connector_arguments_reject_unknown_and_oversized_values_before_network(self):
        with mock.patch.object(science_connectors.public_sources, "_get_json_value") as request:
            with self.assertRaisesRegex(ValueError, "argument_unknown"):
                science_connectors.direct_query("paper-search", {"query": "evidence", "headers": {}})
            with self.assertRaisesRegex(ValueError, "string_invalid"):
                science_connectors.direct_query("paper-search", {"query": "x" * 513})
        request.assert_not_called()

    def test_connector_arguments_enforce_published_numeric_bounds_before_network(self):
        with mock.patch.object(science_connectors.public_sources, "_get_json_value") as request:
            with self.assertRaisesRegex(ValueError, "above_maximum"):
                science_connectors.direct_query("open-meteo", {"latitude": 91, "longitude": 0})
            with self.assertRaisesRegex(ValueError, "integer_invalid"):
                science_connectors.direct_query("paper-search", {"query": "evidence", "limit": True})
            with self.assertRaisesRegex(ValueError, "number_invalid"):
                science_connectors.direct_query("open-meteo", {"latitude": float("inf"), "longitude": 0})
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class MountingTests(unittest.TestCase):
    """The connectors are reachable, which is the whole of what was missing.

    The module was written, tested and mounted nowhere: it ran as a standalone
    stdio bridge that no deployment starts, so `tools/list` never carried one
    of its tools and the model could not call any of them. Every test above
    passed throughout. These assert the other half — that the research server
    publishes them and routes a call to the right connector — because a unit
    test of an unmounted module is exactly the shape of green that hid this.
    """

    def setUp(self):
        self.server = importlib.import_module("server")

    def test_every_connector_is_published_under_its_own_tool_name(self):
        published = {tool["name"]: tool for tool in self.server.TOOL_DEFINITIONS}
        for connector, entry in science_connectors.CONNECTORS.items():
            with self.subTest(connector=connector):
                self.assertIn(entry["tool"], published)
                # The schema shown is the schema enforced: a tool that
                # advertises a field it then refuses is worse than one that
                # never offered it.
                self.assertIs(published[entry["tool"]]["inputSchema"], entry["schema"])

    def test_a_call_reaches_the_connector_the_tool_name_names(self):
        # The stub returns what the connector really returns — the URL it
        # requested, and rows. A shape the real function never produces would
        # pass here and fail in production, which is the fixture mistake this
        # repository has already paid for once.
        with mock.patch.object(
            science_connectors,
            "direct_query",
            return_value={
                "source": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=GDP",
                "data": ["DATE,GDP", "2026-01-01,100"],
            },
        ) as routed:
            result = self.server.call_tool("get_fred_series", {"series_id": "GDP"})
        self.assertEqual(result["status"], "success")
        self.assertEqual(routed.call_args[0][0], "fred")

    def test_bad_input_is_refused_before_anything_is_asked_of_the_network(self):
        with mock.patch.object(science_connectors.public_sources, "_get_json_value") as fetched:
            result = self.server.call_tool("get_weather", {"latitude": 999, "longitude": 0})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_input")
        fetched.assert_not_called()
