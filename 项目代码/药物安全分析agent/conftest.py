"""Make the in-repo ``safety_agent`` package importable from any cwd."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
