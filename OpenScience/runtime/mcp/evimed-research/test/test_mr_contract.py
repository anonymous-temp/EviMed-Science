"""MR source shapes and error normalization at the public MCP boundary."""

import unittest

from test_server import load_server


class MRContractTests(unittest.TestCase):
    def setUp(self):
        self.server = load_server()

    def test_boolean_and_oneof_are_enforced(self):
        for value in ("false", 0, 1, None, {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.server._validate(value, {"type": "boolean"}, "value")
        self.server._validate(False, {"type": "boolean"}, "value")
        schema = {"oneOf": [{"type": "string"}, {"type": "boolean"}]}
        self.server._validate(False, schema, "value")
        with self.assertRaises(ValueError):
            self.server._validate(12, schema, "value")

    def test_local_source_contract_is_explicit_and_strict(self):
        source = {
            "type": "local_file",
            "path": "data/bmi.csv",
            "instrumentsPreclumped": True,
            "clumpingProvenance": "Published selected instruments and clumping method.",
            "columnMapping": dict(
                snp="SNP",
                beta="beta",
                se="se",
                effect_allele="A1",
                other_allele="A2",
                eaf="eaf",
                pval="p",
            ),
        }
        schema = self.server.TOOLS["mendelian_randomization"]["inputSchema"]
        request = dict(
            action="start",
            exposure="BMI",
            outcome="CHD",
            exposureSource=source,
            outcomeSource=source,
        )
        self.server._validate(request, schema, "request")
        for delta in (
            {"instrumentsPreclumped": "false"},
            {"columnMapping": {}},
            {"sampleSize": True},
            {"command": "Rscript"},
        ):
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                self.server._validate(
                    {**request, "exposureSource": {**source, **delta}},
                    schema,
                    "request",
                )
        self.server._validate(
            {**request, "outcomeSource": {"type": "opengwas", "gwasId": "ieu-a-7"}},
            schema,
            "request",
        )
        self.server._validate(
            dict(action="start", exposure="BMI", outcome="CHD"), schema, "request"
        )

    def test_missing_adapter_never_executes_uploaded_sources_in_the_shared_runtime(
        self,
    ):
        jobs = self.server.specialist_jobs
        result = jobs.call(
            "mendelian_randomization",
            {
                "action": "start",
                "exposure": "BMI",
                "outcome": "CHD",
                "exposureSource": {"type": "local_file"},
                "outcomeSource": {"type": "local_file"},
            },
        )
        self.assertEqual(result["error"]["code"], "specialist_agent_unconfigured")
        self.assertTrue(result["error"]["retryable"])
        self.assertNotIn("data", result)
        self.assertNotIn("sources", result)

    def test_error_results_must_never_carry_data_or_sources(self):
        error = self.server.failure(
            "mr_input_changed", "Input changed.", False, "Stop.", ["Submit a new job."]
        )
        for evidence in ({"data": {"jobId": "mr-test"}}, {"sources": []}):
            result = self.server._normalize_tool_result(
                "mendelian_randomization", {**error, **evidence}, {}, {}
            )
            self.assertEqual(result["status"], "error")
            self.assertNotEqual(result["error"]["code"], "mr_input_changed")
        normalized = self.server._normalize_tool_result(
            "mendelian_randomization", error, {}, {}
        )
        self.assertEqual(normalized["error"]["code"], "mr_input_changed")


if __name__ == "__main__":
    unittest.main()
