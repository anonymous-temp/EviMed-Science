from pathlib import Path
import subprocess
import sys


def test_e2e_script_passes_as_standalone_validation() -> None:
    script = Path(__file__).with_name("test_e2e.py")

    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=script.parents[1],
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert result.returncode == 0, result.stdout + result.stderr
