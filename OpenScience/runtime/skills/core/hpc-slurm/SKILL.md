---
name: hpc-slurm
description: Use when the user asks to run, submit, monitor, or cancel a job on an HPC cluster (Slurm, sbatch, "the cluster", a login node) — generating a Slurm batch script in the workspace, submitting it over SSH with the user's own keys, tracking it, and fetching results back into the workspace.
---

# HPC / Slurm over SSH

Run heavy work on the user's Slurm cluster. Everything goes over non-interactive
SSH with the user's own keys — you never install anything on the cluster and
never handle credentials.

## 1 · Find the cluster host

1. `cat .openscience/hpc.json` in the workspace — it looks like
   `{"host":"login-a"}`. The directory is hidden: read the file directly
   instead of relying on `ls`.
2. If the file is missing, ask the user to either connect a cluster in
   **Settings → Cluster (HPC)** or tell you a `user@host` to use. Do not guess.
3. Always call ssh/scp non-interactively:
   `ssh -o BatchMode=yes -o ConnectTimeout=8 <host> '<command>'`.
   If it fails with "Permission denied", tell the user their SSH key does not
   reach the host — do not retry with passwords.

## 2 · Write the batch script in the workspace

Create `slurm/<job-name>.sbatch` **in the workspace** (so it is versioned in
provenance), then copy it over. Template:

Prefer the bundled renderer so job names and optional resource directives are
validated before a file is produced:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/hpc-slurm/render_job.py" \
  --job-name <job-name> --command '<actual command>' \
  --output "slurm/<job-name>.sbatch"
```

Only pass optional renderer flags when the user supplied those resources.

```bash
#!/bin/bash
#SBATCH --job-name=<job-name>
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err
#SBATCH --time=01:00:00

set -euo pipefail
cd "$SLURM_SUBMIT_DIR"
<the actual commands>
```

- Only add `--partition/--gres/--mem/--cpus-per-task` when the user asked for
  them or the cluster rejects the default — do not invent resource numbers.
- Keep the script self-contained; load modules (`module load …`) the user names.

## 3 · Submit

```bash
REMOTE=openscience/jobs/<job-name>-$(date +%Y%m%d-%H%M%S)
ssh -o BatchMode=yes <host> "mkdir -p $REMOTE"
scp -o BatchMode=yes slurm/<job-name>.sbatch <input files> <host>:$REMOTE/
ssh -o BatchMode=yes <host> "cd $REMOTE && sbatch <job-name>.sbatch"
```

Parse the job id from `Submitted batch job <id>` and report it to the user
together with the remote directory. `REMOTE` is only set in this one shell
call — remember the literal directory string and substitute it yourself in
later steps (tracking, fetching). Confirm with the user before copying large
input files (> ~100 MB) to the cluster.

## 4 · Track

- Queued/running: `ssh <host> "squeue -j <id> -h -o '%T %M'"`.
- Finished (squeue returns nothing): try
  `ssh <host> "sacct -j <id> --format=State,Elapsed,ExitCode -n"`; if `sacct`
  is unavailable, check for the output file instead:
  `ssh <host> "cat <remote-dir>/slurm-<id>.out"` (the literal directory from
  step 3).
- Long jobs: report the submitted state and stop; the user watches the queue in
  Settings → Cluster (HPC) and can ask you to check again later. Do not poll in
  a loop for more than ~2 minutes.
- Cancel only jobs you submitted, or when the user explicitly names a job id:
  `ssh <host> "scancel <id>"`.

## 5 · Fetch results back

When the job completes, copy outputs into the workspace so they become
traceable artifacts:

```bash
mkdir -p slurm/<job-name>
scp -o BatchMode=yes "<host>:<remote-dir>/slurm-<id>.out" \
    "<host>:<remote-dir>/<result file>" slurm/<job-name>/
```

`<remote-dir>` is the literal directory you created in step 3 (`$REMOTE` does
not survive into this shell call) — name each file to fetch explicitly.

Summarize: job id, final state (from sacct/squeue — quote it, do not assume
success), elapsed time, and the fetched files. If the job failed, show the tail
of `slurm-<id>.err` and propose a fix instead of resubmitting silently.
