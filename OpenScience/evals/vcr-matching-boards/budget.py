"""A small guard paid runners call before and during a batch.

Reads the DeepSeek key from a file, asks the official balance endpoint for the
CNY balance, prints only that balance and exits non-zero under the floor. The key
is read from a path argument, sent only as the bearer header and never printed,
logged or placed on a command line. A balance read is not a model call.

Exit codes: 0 ok, 2 balance under the floor, 3 balance could not be read,
4 --require-off-peak and it is peak time.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import urllib.request

BALANCE_URL = "https://api.deepseek.com/user/balance"
DEFAULT_FLOOR = 200.0
# Peak is weekdays 01:00-04:00 and 06:00-10:00 UTC (Beijing 09-12 and 14-18); everything else, and weekends, is off-peak.
PEAK_HOURS = (range(1, 4), range(6, 10))


class BalanceError(RuntimeError):
    pass


def is_peak(now):
    now = now.astimezone(timezone.utc)
    return now.weekday() < 5 and any(now.hour in hours for hours in PEAK_HOURS)


def is_off_peak(now=None):
    return not is_peak(now or datetime.now(timezone.utc))


def seconds_until_off_peak(now=None):
    """Zero when it is already off-peak; otherwise the whole minutes' wait, rounded up to the next minute."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(second=0, microsecond=0)
    waited = 0
    while is_peak(now) and waited < 24 * 3600:
        now += timedelta(minutes=1)
        waited += 60
    return waited


def read_key(path):
    key = Path(path).read_text(encoding="utf-8").strip()
    if not key:
        raise BalanceError("the key file is empty")
    return key


def fetch_balance(key, currency="CNY", opener=urllib.request.urlopen, timeout=20):
    """The total balance in `currency`, as a float. Errors never carry the key."""
    request = urllib.request.Request(BALANCE_URL, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with opener(request, timeout=timeout) as response:
            body = json.load(response)
    except Exception as error:  # urllib and json errors; the message is scrubbed below
        text = str(error).replace(key, "***")
        raise BalanceError(f"the balance request failed: {type(error).__name__}: {text[:200]}") from None
    for entry in body.get("balance_infos") or []:
        if entry.get("currency") == currency:
            try:
                return float(entry["total_balance"])
            except (KeyError, TypeError, ValueError):
                break
    raise BalanceError(f"the balance response has no usable {currency} balance")


def main(argv=None, now=None, opener=urllib.request.urlopen, out=sys.stdout):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--key-file", type=Path, required=True, help="file holding the DeepSeek API key")
    parser.add_argument("--floor", type=float, default=DEFAULT_FLOOR, help="exit 2 when the CNY balance is under this (default 200)")
    parser.add_argument("--currency", default="CNY")
    parser.add_argument("--require-off-peak", action="store_true", help="exit 4 during peak time, before reading the balance")
    args = parser.parse_args(argv)
    if args.require_off_peak and not is_off_peak(now):
        print("peak time: wait", seconds_until_off_peak(now), "seconds", file=out)
        return 4
    try:
        balance = fetch_balance(read_key(args.key_file), args.currency, opener)
    except (BalanceError, OSError) as error:
        print(f"balance unavailable: {str(error)[:200]}", file=out)
        return 3
    print(f"balance {args.currency} {balance:.2f}", file=out)
    if balance < args.floor:
        print(f"under the floor of {args.floor:.2f}: stop", file=out)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
