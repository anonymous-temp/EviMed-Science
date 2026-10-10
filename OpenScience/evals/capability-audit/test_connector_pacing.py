"""A qualification probe respects upstream pacing and preserves refusals."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import run_connector_audit as audit


class ConnectorPacing(unittest.TestCase):
    def setUp(self):
        self.previous = dict(audit._LAST_REQUEST)
        self.limited = set(audit._RATE_LIMITED)
        audit._LAST_REQUEST.clear()
        audit._RATE_LIMITED.clear()

    def tearDown(self):
        audit._LAST_REQUEST.clear()
        audit._LAST_REQUEST.update(self.previous)
        audit._RATE_LIMITED.clear()
        audit._RATE_LIMITED.update(self.limited)

    def test_arxiv_requests_wait_for_the_published_interval(self):
        clock = [10.0]

        def pause(seconds):
            clock[0] += seconds

        with patch.object(audit.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(audit.time, 'sleep', side_effect=pause) as sleep:
            audit.pace_request('arxiv')
            clock[0] += 0.4
            audit.pace_request('arxiv')
        self.assertAlmostEqual(sleep.call_args.args[0], 2.7)
        self.assertAlmostEqual(clock[0], 13.1)

    def test_rate_limit_stops_retries_and_further_queries_without_certifying_them(self):
        server = SimpleNamespace(call_tool=Mock(return_value={
            'status': 'error', 'summary': 'Public source returned HTTP 429.',
            'error': {'code': 'public_source_http_error', 'message': 'Public source returned HTTP 429.', 'retryable': True},
        }), public_sources=SimpleNamespace(BUNDLED_DATASET_SOURCE_IDS=()))
        with patch.object(audit.time, 'sleep') as sleep:
            first = audit.probe_case(server, 'arxiv', 'first', True)
            second = audit.probe_case(server, 'arxiv', 'second', True)
        self.assertEqual(server.call_tool.call_count, 1)
        sleep.assert_not_called()
        self.assertEqual([first['attempts'], second['attempts']], [1, 0])
        self.assertEqual(second['executionRoute'], 'not_executed')
        result = audit.source_result('arxiv', [first, second], True)
        self.assertFalse(result['qualityChecks']['twoQueriesExecuted'])
        self.assertEqual(result['status'], 'quality_fail')

    def test_an_open_circuit_is_not_retried_in_a_tight_loop(self):
        server = SimpleNamespace(call_tool=Mock(return_value={
            'status': 'error', 'error': {'code': 'adapter_circuit_open', 'retryable': True},
        }), public_sources=SimpleNamespace(BUNDLED_DATASET_SOURCE_IDS=()))
        with patch.object(audit.time, 'sleep') as sleep:
            result = audit.probe_case(server, 'who-gho', 'first', True)
        self.assertEqual(result['attempts'], 1)
        sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
