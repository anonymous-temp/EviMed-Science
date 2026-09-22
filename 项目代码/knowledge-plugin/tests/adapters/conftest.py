"""Reader tests (package P2): recorded real upstream answers, replayed through the adapters.

The fixtures live in ``tests/fixtures/<group>/<case>/`` and are written only by
``tests/fixtures/record.py`` (see ``tests/fixtures/replay.py`` for the layout).
"""

from __future__ import annotations

import sys
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
if str(FIXTURES) not in sys.path:
    sys.path.insert(0, str(FIXTURES))
