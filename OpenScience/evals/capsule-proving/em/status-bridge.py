#!/usr/bin/env python3
"""Copy the two remaining completed/terminated step lines into the shared log.

Runs on the development host; reads only the EM lab status, never result data
or keys. Ledger appends remain the lab runner's responsibility.
"""
import pathlib
import subprocess
import time

status = pathlib.Path('/home/coder/evimed-wt/memdata-data/STATUS')
while True:
    previous = status.read_text()
    done2 = ' EM STEP2 DONE ' in previous
    done4 = any(marker in previous for marker in [' EM STEP4 DONE ', ' EM STEP4 PARTIAL '])
    if done2 and done4:
        break
    try:
        remote = subprocess.check_output(['ssh', '-o', 'ConnectTimeout=10', 'evimed-lab',
                                          'cat /srv/evimed/runs/EM-STATUS'], text=True, timeout=30)
    except (subprocess.SubprocessError, OSError):
        time.sleep(60)
        continue
    for line in remote.splitlines():
        if not done2 and ' EM STEP2 DONE ' in line:
            with status.open('a') as stream:
                stream.write(line + '\n')
            done2 = True
        if not done4 and (' EM STEP4 DONE ' in line or ' EM STOP ' in line):
            line = line.replace(' EM STOP ', ' EM STEP4 PARTIAL ')
            with status.open('a') as stream:
                stream.write(line + '\n')
            done4 = True
    time.sleep(60)
