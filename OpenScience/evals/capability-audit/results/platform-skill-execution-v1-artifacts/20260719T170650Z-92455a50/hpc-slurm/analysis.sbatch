#!/bin/bash
#SBATCH --job-name=evimed-audit
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err
#SBATCH --time=00:10:00
#SBATCH --cpus-per-task=2

set -euo pipefail
cd "$SLURM_SUBMIT_DIR"
module load python/3.11
python analysis.py
