#!/usr/bin/env python3
"""SkillLearnBench registry adapter to the reference Pi agent (no custom agent loop)."""
import json
import os
import pathlib

root = pathlib.Path.home() / '.pi/agent'
root.mkdir(parents=True, exist_ok=True)
config = {'providers': {'deepseek': {
    'baseUrl': os.environ['SB_GATEWAY_URL'], 'api': 'openai-completions', 'apiKey': 'lab-proxy',
    'models': [{'id': 'deepseek-flash', 'name': 'DeepSeek Flash', 'reasoning': True,
                'input': ['text'], 'contextWindow': 1048576, 'maxTokens': 32768}],
}}}
(root / 'models.json').write_text(json.dumps(config))
os.environ['PI_TELEMETRY'] = '0'
os.environ['PATH'] = '/opt/benchflow/node/bin:/opt/benchflow/js-agents/bin:' + os.environ['PATH']
cmd = ['/opt/benchflow/js-agents/bin/pi', '--print', '--mode', 'json', '--provider', 'deepseek',
       '--model', 'deepseek-flash', '--thinking', 'high', '--session-dir', '/logs/agent/sessions',
       '--no-extensions', '--no-prompt-templates', '--no-context-files',
       '--append-system-prompt', 'Complete the task using the supplied inputs. Do not inspect /tests, /verifier, /oracle or /solution. These paths belong to the evaluator.']
skills = pathlib.Path('/root/.agents/skills')
if any(skills.glob('*/SKILL.md')):
    cmd += ['--skill', str(skills)]
else:
    cmd += ['--no-skills']
cmd += [pathlib.Path('/tmp/instruction.txt').read_text()]
os.execv(cmd[0], cmd)
