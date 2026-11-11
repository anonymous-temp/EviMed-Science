#!/usr/bin/env python3
"""Keep one admitted slot through phase transitions; release when its campaign ends or expires."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import signal
import time
from slot_capacity import process_token


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--campaign-pid', type=int, required=True)
    p.add_argument('--campaign-token', required=True)
    p.add_argument('--deadline', required=True)
    p.add_argument('--locks-dir', default='/srv/evimed/pp/locks')
    args = p.parse_args()
    root = Path(args.locks_dir)
    file = root / f'eg-reservation-{os.getpid()}.json'
    deadline = datetime.fromisoformat(args.deadline.replace('Z', '+00:00')).timestamp()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    publish_deadline = time.monotonic() + 5
    while not file.exists() and time.monotonic() < publish_deadline:
        time.sleep(0.01)
    if not file.exists():
        raise SystemExit(2)
    try:
        while process_token(args.campaign_pid) == args.campaign_token and time.time() < deadline:
            time.sleep(min(5, max(0, deadline - time.time())))
    finally:
        with (root / 'eg-capacity.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if file.exists():
                held = json.loads(file.read_text())
                if held.get('pid') == os.getpid() and held.get('campaignPid') == args.campaign_pid and held.get('campaignToken') == args.campaign_token:
                    file.unlink()


if __name__ == '__main__':
    main()
