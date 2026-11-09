#!/usr/bin/env python3
"""Bound one explicitly named local evaluation container; never targets other resources."""
import datetime, json, pathlib, subprocess, sys, time
name = sys.argv[1]
if name != 'codex-vcr-synth-full':
    raise SystemExit('Refusing to control an unrelated container')
out = pathlib.Path(sys.argv[2]); cpu_limit = float(sys.argv[3]); wall_limit = float(sys.argv[4])
initial = subprocess.run(['docker','inspect','-f','{{.State.StartedAt}}',name], text=True, capture_output=True)
if initial.returncode:
    out.write_text(json.dumps({'state':'ended','reason':'container_finished_before_sampling','cpuSecondsLastSample':None})+'\n')
    raise SystemExit(0)
started = initial.stdout.strip()
start = datetime.datetime.fromisoformat(started.replace('Z','+00:00')[:26]+'+00:00')
last_cpu = None
while True:
    state = subprocess.run(['docker','inspect','-f','{{.State.Running}}',name],text=True,capture_output=True)
    wall = (datetime.datetime.now(datetime.timezone.utc)-start).total_seconds()
    if state.returncode or state.stdout.strip() != 'true':
        reason = 'container_finished'; break
    read = subprocess.run(['docker','exec',name,'cat','/sys/fs/cgroup/cpu.stat'],text=True,capture_output=True)
    if read.returncode:
        reason = 'cpu_measurement_unavailable'; subprocess.run(['docker','stop','-t','15',name],capture_output=True); break
    fields = dict(line.split() for line in read.stdout.splitlines() if len(line.split()) == 2)
    last_cpu = int(fields['usage_usec']) / 1e6
    if last_cpu >= cpu_limit or wall >= wall_limit:
        reason = 'cpu_limit' if last_cpu >= cpu_limit else 'wall_limit'
        subprocess.run(['docker','stop','-t','15',name],capture_output=True); break
    out.write_text(json.dumps({'state':'running','cpuSeconds':last_cpu,'wallSeconds':wall,'cpuLimit':cpu_limit,'wallLimit':wall_limit})+'\n')
    time.sleep(10)
out.write_text(json.dumps({'state':'ended','reason':reason,'cpuSecondsLastSample':last_cpu,'wallSeconds':wall,'cpuLimit':cpu_limit,'wallLimit':wall_limit})+'\n')
