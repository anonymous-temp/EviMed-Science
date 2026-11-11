#!/usr/bin/env python3
"""Reference BenchFlow CLI with the measured npm agent versions frozen."""
from benchflow.agents.registry import AGENTS, AGENT_INSTALLERS
import redaction_compat
import json
import pathlib
import sys

compatibility = redaction_compat.apply()
if '--jobs-dir' in sys.argv:
    jobs = pathlib.Path(sys.argv[sys.argv.index('--jobs-dir') + 1])
    jobs.mkdir(parents=True, exist_ok=True)
    (jobs / 'logging-compat.json').write_text(json.dumps(compatibility, indent=2) + '\n')

agent = AGENTS['pi-acp']
agent.install_cmd = agent.install_cmd.replace('@mariozechner/pi-coding-agent@latest', '@earendil-works/pi-coding-agent@1.5.2').replace('pi-acp@latest', 'pi-acp@0.0.34')
AGENT_INSTALLERS['pi-acp'] = agent.install_cmd
agent.acp_effort_config_id = 'thought_level'

if __name__ == '__main__':
    # Same entry point as the installed `bench` script.
    from benchflow.cli.main import app
    app()
