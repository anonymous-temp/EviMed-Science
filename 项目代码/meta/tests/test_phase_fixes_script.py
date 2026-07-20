from pathlib import Path
import subprocess
import sys


def test_phase_fixes_script_passes_as_standalone_validation() -> None:
    script = Path(__file__).with_name("test_phase_fixes.py")

    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=script.parents[1],
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stdout + result.stderr
