#!/usr/bin/env python3
"""Eval-only stdio adapter exposing the existing VCR tools and no filesystem tool."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime/mcp/evimed-research'))
import vcr_platform

handlers = {'vcr_read': vcr_platform.read, 'vcr_write': vcr_platform.write, 'vcr_simulate': vcr_platform.simulate}
for line in sys.stdin:
    try:
        request = json.loads(line)
        if 'id' not in request:
            continue
        method, params = request.get('method'), request.get('params', {})
        if method == 'initialize':
            result = {'protocolVersion': params.get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'native-vcr-evaluation', 'version': '1'}}
        elif method == 'tools/list':
            result = {'tools': [tool for tool in vcr_platform.tool_definitions() if tool['name'] in handlers]}
        elif method == 'tools/call':
            try:
                value = handlers[params['name']](params.get('arguments', {}))
                result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}]}
            except Exception as error:
                result = {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
        else:
            result = {}
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}, ensure_ascii=False), flush=True)
    except (ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
