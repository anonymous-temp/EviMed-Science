#!/usr/bin/env python3
"""Reserve capacity with the EG lane's shared lock and reservation format before running L3B. No other process is stopped."""
import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/srv/evimed/runs')
LOCKS=Path('/srv/evimed/pp/locks')
LOCKS.mkdir(parents=True,exist_ok=True)
plan=sys.argv[1] if len(sys.argv)>1 else 'A,B,C,D'
if not plan or any(a not in 'ABCD' or len(a)!=1 for a in plan.split(',')) or len(set(plan.split(',')))!=len(plan.split(',')):
    raise SystemExit('Expected a comma-separated subset of A,B,C,D')
port=os.environ.get('PORT','48853')
slot=f'/srv/evimed/pp/live/p{port}-l3b'
reservation=LOCKS/f'eg-reservation-{os.getpid()}.json'
budget_file=ROOT/'l3b-budget.json'
def log(s):
    text=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')+' L3B '+s
    print(text,flush=True)
    with (ROOT/'l3b-STATUS').open('a') as f:f.write(text+'\n')
def balance():return float((ROOT/'BUDGET-LAST').read_text().split()[-1])
if not budget_file.exists():
    before=balance()
    if before<400:raise SystemExit('Batch balance below CNY 400')
    with budget_file.open('x') as f:json.dump(dict(balanceBefore=before,startedAt=time.time(),deadlineMs=(time.time()+12*3600)*1000,capCny=400),f)
budget=json.loads(budget_file.read_text())
log('queued for shared product-path capacity')
while True:
    current=balance()
    if current<400 or time.time()*1000>budget['deadlineMs']:
        log(f'capacity wait stopped by budget/time guard; balance={current}');raise SystemExit(3)
    with (LOCKS/'eg-capacity.lock').open('a') as gate:
        fcntl.flock(gate,fcntl.LOCK_EX)
        slots=set()
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():continue
            try:
                argv=(entry/'cmdline').read_bytes().split(b'\0')
                if len(argv)>1 and b'node' in argv[0]:
                    env=dict(s.split(b'=',1) for s in (entry/'environ').read_bytes().split(b'\0') if b'=' in s)
                    live=env.get(b'EVAL_LIVE_DIR',env.get(b'LIVE_DIR',b'')).decode(errors='replace')
                    if live.startswith('/srv/evimed/pp/live/'):
                        slots.add(live)
            except OSError:pass
        for file in LOCKS.glob('eg-reservation-*.json'):
            held=json.loads(file.read_text())
            if Path(f"/proc/{held['pid']}").exists():slots.add(held['slot'])
            else:file.unlink(missing_ok=True)
        available=int(next(s.split()[1] for s in Path('/proc/meminfo').read_text().splitlines() if s.startswith('MemAvailable:')))
        start=len(slots)<2 and available>1700*1024
        if start:reservation.write_text(json.dumps(dict(pid=os.getpid(),slot=slot)))
    if start:
        log(f'starting reserved slot={slot}, existing={len(slots)}, availableKiB={available}')
        try:
            result=subprocess.call(['bash',str(HERE/'lab.sh'),plan],env={**os.environ,'PORT':port,'L3B_CAPACITY_RESERVED':'1'})
            log(f'batch exited code={result}')
            raise SystemExit(result)
        finally:reservation.unlink(missing_ok=True)
    log(f'waiting: slots={len(slots)}, availableKiB={available}')
    time.sleep(30)
