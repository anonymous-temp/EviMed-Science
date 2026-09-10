#!/usr/bin/env python3
"""What the release audit says when its evidence has gone out of date.

Two defects, both reproduced against the real checker on 2026-09-10:

  1. `pnpm audit:capabilities` said exactly "tool audit evidence is stale" and
     nothing else, because freshness was the first thing `verify_tools()`
     checked -- so the run died before loading the registry and could not
     notice that the probe covers 25 tools while the registry declares 34, nor
     that it records them under the retired `evimed_` prefix. Refreshing the
     timestamp would have produced a second, different failure.
  2. `verify_sources()` compared the catalog against eleven numbers written
     into this file. Adding one data source made the release red with
     "reviewed data-source count drifted", and the only way past was to edit
     the expectation.

These tests are also the guard on the fix: they assert the window is not
widened and that a fresh probe covering too few tools is still refused.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

_spec = importlib.util.spec_from_file_location("evimed_release_audit_under_test", HERE / "verify_release_audit.py")
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

REGISTRY = {"health", "literature_search", "web_search", "guideline_search"}


def probe(*, days_ago, tools, prefix=""):
    at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "schemaVersion": 3,
        "probedAt": at.isoformat().replace("+00:00", "Z"),
        "registered": len(tools),
        "results": [{"tool": "%s%s" % (prefix, name)} for name in tools],
    }


class ToolProbeCurrency(unittest.TestCase):
    def test_a_current_complete_probe_raises_nothing(self):
        audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY), REGISTRY, set())

    def test_the_window_is_fourteen_days_and_was_not_widened(self):
        # The probe cannot be refreshed without a live deployment, and widening
        # the window is the one repair that would make this green while proving
        # less. Pinned so that doing it is a test change somebody has to make on
        # purpose.
        self.assertEqual(audit.TOOL_PROBE_WINDOW_DAYS, 14)
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=15, tools=REGISTRY), REGISTRY, set())
        self.assertIn("the window is 14 days", str(raised.exception))

    def test_a_fresh_probe_that_covers_too_few_tools_is_still_refused(self):
        # The failure the old ordering hid: freshness alone is not currency.
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=0, tools={"health"}), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("the registry declares 4", message)
        self.assertIn("never probed", message)
        for name in REGISTRY - {"health"}:
            self.assertIn(name, message)

    def test_a_stale_undersized_probe_reports_both_reasons_at_once(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=41, tools={"health"}), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("days ago", message)
        self.assertIn("the registry declares 4", message)
        self.assertIn("run_tool_audit.py", message)
        self.assertIn("no deployment reachable", message)

    def test_the_retired_prefix_is_named_rather_than_read_as_missing_probes(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=0, tools=REGISTRY, prefix="evimed_"), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("retired `evimed_` prefix", message)
        # Once unwrapped they are the registry, so nothing may be reported as
        # never probed: that diff is what made one rename read as 59 holes.
        self.assertNotIn("never probed", message)

    def test_a_tool_the_deployment_declined_is_a_denominator_not_a_hole(self):
        audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY - {"web_search"}), REGISTRY, {"web_search"})

    def test_the_message_names_the_evidence_file(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=41, tools=REGISTRY), REGISTRY, set())
        self.assertIn("tool-probe-v3.json", str(raised.exception))


class SourceCountsAreDerived(unittest.TestCase):
    """The catalog, its published summary and the connector registry agree.

    Run against the real catalog: a fixture here would prove that a fixture is
    self-consistent. The mutation cases below then perturb the summary the
    product publishes and require the checker to notice.
    """

    @classmethod
    def setUpClass(cls):
        # `public_sources` and its siblings import each other by their real
        # names, so the server has to put their directory on the path first --
        # the same order `verify_tools()` establishes in a real run.
        audit.load_module("evimed_release_tool_registry", audit.REPO / "runtime" / "mcp" / "evimed-research" / "server.py")
        cls.catalog = audit.load_module(
            "evimed_source_catalog_counts_test",
            audit.REPO / "runtime" / "mcp" / "evimed-research" / "source_catalog.py",
        )

    def test_no_count_in_the_audit_is_written_down(self):
        source = (HERE / "verify_release_audit.py").read_text(encoding="utf-8")
        body = source.split("def verify_sources")[1].split("\ndef ")[0]
        # The eleven literals that used to live here. Any bare integer other
        # than 0 in a comparison is the defect coming back.
        import re

        written = sorted({int(value) for value in re.findall(r"==\s*(\d+)", body)} - {0})
        self.assertEqual(written, [], "verify_sources compares against written-down counts: %s" % written)

    def test_the_real_catalog_reconciles_three_ways(self):
        summary = self.catalog.integration_summary()
        rows = self.catalog.sources()
        counted = Counter(str(item.get("connectionState")) for item in rows)
        self.assertGreater(len(rows), 0, "the catalog is empty; this test proved nothing")
        self.assertEqual(summary["reviewedTotal"], len(rows))
        self.assertEqual(dict(summary["connectionStateCounts"]), dict(counted))
        self.assertEqual(summary["notConnected"], len(rows) - summary["connectedPublic"] - summary["skillGuidanceOnly"])

    def _verify_sources_with(self, perturb):
        """Run the real `verify_sources()` over a perturbed summary."""
        real_load = audit.load_module

        def load(name, module_file):
            module = real_load(name, module_file)
            if Path(module_file).name == "source_catalog.py":
                summary = module.integration_summary()
                module.integration_summary = lambda: perturb(dict(summary))
            return module

        audit.load_module = load
        try:
            audit.verify_sources()
        finally:
            audit.load_module = real_load

    def test_the_checker_passes_on_the_catalog_as_it_stands(self):
        self._verify_sources_with(lambda summary: summary)

    def test_a_summary_that_miscounts_its_own_rows_is_caught(self):
        with self.assertRaises(SystemExit) as raised:
            self._verify_sources_with(lambda summary: {**summary, "reviewedTotal": summary["reviewedTotal"] + 1})
        self.assertIn("does not reconcile with the catalog", str(raised.exception))

    def test_a_state_moved_between_buckets_is_caught_even_though_the_total_holds(self):
        # The mutation the total cannot see: one source reclassified from
        # blocked-by-licence to blocked-by-approval. The sum is unchanged, so
        # only a per-state comparison against the rows notices.
        def reclassify(summary):
            states = dict(summary["connectionStateCounts"])
            states["blocked_license"] = states.get("blocked_license", 0) - 1
            states["blocked_approval"] = states.get("blocked_approval", 0) + 1
            return {**summary, "connectionStateCounts": states}

        with self.assertRaises(SystemExit) as raised:
            self._verify_sources_with(reclassify)
        self.assertIn("do not reconcile with the catalog rows", str(raised.exception))

    def test_adding_a_data_source_does_not_blow_the_audit_up(self):
        # The property the eleven literals cost: a catalog that grew by one, in
        # every count that describes it, is a legitimate change and not a
        # release blocker.
        def grow(summary):
            states = dict(summary["connectionStateCounts"])
            states["blocked_license"] = states.get("blocked_license", 0) + 1
            return {
                **summary,
                "reviewedTotal": summary["reviewedTotal"] + 1,
                "notConnected": summary["notConnected"] + 1,
                "connectionStateCounts": states,
            }

        # It still fails, because the *rows* did not grow -- which is the point:
        # the check is against the catalog, not against a number. The message
        # names the disagreement rather than a count nobody can interpret.
        with self.assertRaises(SystemExit) as raised:
            self._verify_sources_with(grow)
        self.assertIn("rows", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
