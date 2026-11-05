"""Bounded JSON entry to the existing clinical calculator source, with no dynamic code."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "clinical"))
import clinical_scores

try:
    request = json.loads(sys.stdin.buffer.read(262145))
    answer = clinical_scores.call(request)
except clinical_scores.ScoreError as error:
    answer = {"status": "unsupported", "code": error.code, "data": error.data}
except (ValueError, TypeError, KeyError):
    answer = {"status": "unsupported", "code": "matching_compute_input_invalid", "data": {}}
json.dump(answer, sys.stdout, ensure_ascii=False, allow_nan=False)
