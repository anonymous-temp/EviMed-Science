from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest

import budget

KEY = "unit-test-key-material-0001"


def utc(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=timezone.utc)  # 2 Nov 2026 is a Monday


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def opener_returning(body, seen=None):
    def opener(request, timeout=None):
        if seen is not None:
            seen.append(request)
        return FakeResponse(json.dumps(body).encode())
    return opener


class PeakTests(unittest.TestCase):
    def test_weekday_peak_windows_are_half_open(self):
        peak = [(2, 1, 0), (2, 3, 59), (2, 6, 0), (2, 9, 59), (6, 2, 30)]  # Mon, Fri
        off = [(2, 0, 59), (2, 4, 0), (2, 5, 59), (2, 10, 0), (2, 23, 0)]
        for day, hour, minute in peak:
            self.assertFalse(budget.is_off_peak(utc(day, hour, minute)), (day, hour, minute))
        for day, hour, minute in off:
            self.assertTrue(budget.is_off_peak(utc(day, hour, minute)), (day, hour, minute))

    def test_weekends_are_off_peak_all_day(self):
        for day in (7, 8):  # Saturday, Sunday
            for hour in range(24):
                self.assertTrue(budget.is_off_peak(utc(day, hour)))

    def test_wait_until_off_peak(self):
        self.assertEqual(budget.seconds_until_off_peak(utc(2, 12)), 0)
        self.assertEqual(budget.seconds_until_off_peak(utc(2, 3, 30)), 30 * 60)
        self.assertEqual(budget.seconds_until_off_peak(utc(2, 6, 0)), 4 * 3600)

    def test_a_local_time_zone_is_converted_before_judging(self):
        beijing = datetime(2026, 11, 2, 10, 0, tzinfo=timezone(timedelta(hours=8)))  # 02:00 UTC Monday
        self.assertFalse(budget.is_off_peak(beijing))


class BalanceTests(unittest.TestCase):
    body = {"is_available": True, "balance_infos": [{"currency": "USD", "total_balance": "9.00"},
                                                     {"currency": "CNY", "total_balance": "472.83", "granted_balance": "0", "topped_up_balance": "472.83"}]}

    def run_main(self, key_file, *args, opener=None, now=None):
        out = io.StringIO()
        code = budget.main(["--key-file", str(key_file), *args], now=now, opener=opener or opener_returning(self.body), out=out)
        return code, out.getvalue()

    def key_file(self, directory, text=KEY + "\n"):
        path = Path(directory) / "key"
        path.write_text(text)
        return path

    def test_prints_only_the_balance_and_sends_the_key_as_a_bearer_header(self):
        seen = []
        with tempfile.TemporaryDirectory() as directory:
            code, text = self.run_main(self.key_file(directory), opener=opener_returning(self.body, seen))
        self.assertEqual((code, text), (0, "balance CNY 472.83\n"))
        self.assertEqual(seen[0].get_header("Authorization"), f"Bearer {KEY}")
        self.assertEqual(seen[0].full_url, "https://api.deepseek.com/user/balance")

    def test_under_the_floor_exits_two(self):
        with tempfile.TemporaryDirectory() as directory:
            code, text = self.run_main(self.key_file(directory), "--floor", "500")
            self.assertEqual(code, 2)
            self.assertIn("balance CNY 472.83", text)
            self.assertEqual(self.run_main(self.key_file(directory), "--floor", "472.83")[0], 0)
            low = {"balance_infos": [{"currency": "CNY", "total_balance": "199.99"}]}
            self.assertEqual(self.run_main(self.key_file(directory), opener=opener_returning(low))[0], 2)  # default floor 200

    def test_the_key_never_appears_in_output_even_when_the_request_fails(self):
        def failing(request, timeout=None):
            raise RuntimeError(f"connection refused while sending Bearer {KEY}")
        with tempfile.TemporaryDirectory() as directory:
            code, text = self.run_main(self.key_file(directory), opener=failing)
        self.assertEqual(code, 3)
        self.assertNotIn(KEY, text)
        self.assertIn("***", text)

    def test_unreadable_answers_exit_three(self):
        with tempfile.TemporaryDirectory() as directory:
            for body in ({}, {"balance_infos": [{"currency": "CNY", "total_balance": "n/a"}]}, {"balance_infos": [{"currency": "USD", "total_balance": "5"}]}):
                self.assertEqual(self.run_main(self.key_file(directory), opener=opener_returning(body))[0], 3)
            self.assertEqual(self.run_main(self.key_file(directory, "\n"))[0], 3)
            self.assertEqual(self.run_main(Path(directory) / "missing")[0], 3)

    def test_require_off_peak_refuses_before_any_request(self):
        seen = []
        with tempfile.TemporaryDirectory() as directory:
            code, text = self.run_main(self.key_file(directory), "--require-off-peak", opener=opener_returning(self.body, seen), now=utc(2, 2))
            self.assertEqual((code, seen), (4, []))
            self.assertIn("peak", text)
            self.assertEqual(self.run_main(self.key_file(directory), "--require-off-peak", now=utc(2, 11))[0], 0)

    def test_the_key_is_a_file_argument_not_a_value(self):
        parser_source = Path(budget.__file__).read_text()
        self.assertNotIn("--key ", parser_source)
        self.assertIn("--key-file", parser_source)


if __name__ == "__main__":
    unittest.main()
