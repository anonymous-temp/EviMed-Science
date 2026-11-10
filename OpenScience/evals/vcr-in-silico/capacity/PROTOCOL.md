# R17: engine capacity, one job at a time against two (frozen 2026-11-10, before any measured run)

Question: should the production engine run one job at a time (today) or two,
and what would the host need? Plan §B "1-vs-2 engine capacity test", task R17.

## What exists
The engine service (`项目代码/vcr-engine/service/app.py`) has exactly one worker
thread and one in-memory FIFO queue; there is no concurrency setting. The control
plane's `vcrWorker.mjs` claims `jobs.maxConcurrent` (default 1) engine-lane jobs at
a time, but one engine still runs them serially. So "two" means two engine
processes, each with its own work directory (what two containers, or a worker
count added to `Engine`, would give). This test builds that: N engine
services, N independent R children, and a FIFO dispatcher with N slots in the
driver (the shape of the control plane at `maxConcurrent = N` over N engines).
No product code is changed.

## Host and limits
- Everything (driver, services, R children) runs under `taskset -c 2,3`: two
  cores, the shared dev box's other pair belongs to another stream. Job `cores` is
  1 (`VCR_ENGINE_CORES=1`, the production default), so a job uses one core; one
  engine uses 1 of the 2 cores, two engines use both.
- `VCR_R_LIBS=/home/coder/R/vcr-4.3`, one token and one receipt key from files in
  scratch, `VCR_ENGINE_CPU_SECONDS=600`, ports 48891 (and 48892).
- No paid calls, no container build.

## Workload (fixed schedule, identical for both settings)
Job bodies are the domain's own fixture jobs
(`packages/domain/test/fixtures/vcr-engine-jobs.json`), selected by name; the
driver only raises `replicates` where stated. Service times are measured alone
at one core on this box (calibration, 2026-11-10):

| class | label | job (fixture name) | alone |
|---|---|---|---|
| interactive | I1 | `design_analytic #20` (time-to-event sample size) | 1.5 s |
| interactive | I2 | `analytic: a non-inferiority margin on a mean` | 1.3 s |
| interactive | I3 | `generate_progression #2` (Emax progression) | 2.0 s |
| interactive | I4 | `generate_progression #5` (beta_logit AD progression) | 4.1 s |
| interactive | I5 | `a campaign screening run ...` (500 replicates) | 2.0 s |
| batch | B1 | `design_simulation #25` with `replicates` 40000 | ~44 s (20000 measured 22 s in the smoke run) |
| batch | B2 | `modestly weighted: a grid of designs ...` (a campaign unit) | 23 s |
| batch | B3 | `design_grid #30` | 17 s |

Cycle of 120 s, repeated 5 times (600 s of arrivals; arrival times are offsets
from the start, jobs are submitted at their offset whatever the queue holds):
- B1 at +0 s, B2 at +10 s, B3 at +60 s.
- One interactive job every 10 s at +5, +15, ... +115 (12 per cycle), classes
  I1..I5 round-robin in arrival order.
- Offered work per cycle is about 80 s of batch plus 12 x 2.2 s of interactive
  = about 106 s per 120 s: 0.9 utilisation of one worker, a loaded but not
  broken queue. 5 x 15 = 75 jobs per setting.
- Seeds: `20260929 + arrival index`; ids `r17_<setting>_<index>`. The same arrival
  index has the same body and seed in both settings.

## Settings
- `n1`: one engine, one slot (today's production).
- `n2`: two engines, two slots. Dispatch: the oldest queued job goes to the
  first idle slot.
Order of runs: n1, n2, n1 again (the repeat checks the box's own noise and that a
repeat is bit-identical). Interactive jobs are never prioritised; FIFO.

## Measures
Per job: submit time, start time (state first seen not `queued`, polled every
50 ms), end time (terminal state), `queue wait` = start - submit, `latency` =
end - submit, the job's CPU seconds from the engine.
Per setting: p50/p95/max of interactive latency and of queue wait for each
class; throughput (jobs per minute and engine CPU seconds per wall second) over
the span first arrival to last completion; makespan; failures (any state but
`succeeded`); peak and mean of the engines' RSS and PSS (service process plus all
R descendants, sampled every 0.5 s with the sum over engines); host
`MemAvailable` low point.
Reproducibility: for every arrival index, the result's `outputHash` and the
sha256 of the canonical result with the manifest's wall-clock fields
(`startedAt`, `finishedAt`, `cpuSeconds`, `cores`, `platform`) removed must be
equal between `n1`, `n2` and the repeat. Any difference is a defect and is
reported, not hidden.

## Decision rule (fixed now)
Two is justified only if all hold: (1) interactive p95 latency under `n2` is at
most half of `n1`'s, (2) no job fails and every result is bit-identical,
(3) batch throughput does not fall, (4) the peak PSS of both engines plus the
rest of the host's resident set stays within the host's memory with a margin
(stated in the RUN file for the production box), and (5) the measured benefit
holds with the two cores the box gives, not only with idle cores another
product needs (the production host is a shared four-core box, plan 11.4). Else
production stays at one.
