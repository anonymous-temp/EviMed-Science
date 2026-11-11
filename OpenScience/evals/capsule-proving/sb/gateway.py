#!/usr/bin/env python3
"""Lab-only DeepSeek proxy: keys stay on the host; usage is attributed per trial.

The reference harness owns the agent loop. This proxy changes only model,
thinking effort, usage reporting and the lane's spending boundary.
"""
import argparse
import base64
import datetime
import http.server
import json
import pathlib
import threading
import urllib.error
import urllib.request


def cost(usage):
    prompt = usage.get('prompt_tokens', 0)
    cached = min(prompt, usage.get('prompt_cache_hit_tokens', 0))
    return ((prompt - cached) * 2 + cached * .04 + usage.get('completion_tokens', 0) * 8) / 1e6


def request_context(url, fallback):
    if '/trial/' not in url:
        return json.loads(fallback.read_text())
    token = url.split('/trial/', 1)[1].split('/', 1)[0]
    context = json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)))
    if not all(isinstance(context.get(k), str) for k in ['runId', 'task', 'arm']):
        raise ValueError('Invalid trial attribution')
    return context


def serve(args):
    root = pathlib.Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    key = pathlib.Path(args.key_file).read_text().strip()
    lock = threading.Lock()
    usage_file = root / 'usage.jsonl'
    spent = sum(json.loads(s).get('costCny', 0) for s in usage_file.read_text().splitlines()) if usage_file.exists() else 0

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'

        def log_message(self, *_):
            pass

        def do_GET(self):
            data = json.dumps({'object': 'list', 'data': [{'id': 'deepseek-flash', 'object': 'model'}]}).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            nonlocal spent
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                balance_text = pathlib.Path('/srv/evimed/runs/BUDGET-LAST').read_text()
                balance = float(balance_text.split('balance ')[1].split()[0])
                practice_file = root / 'practice/usage.json'
                practice = json.loads(practice_file.read_text()).get('account', {}) if practice_file.exists() else {}
                practice_cost = practice.get('actualCost', 0) + practice.get('reservedCost', 0)
                with lock:
                    if spent + practice_cost >= args.cap - 5 or balance < 160:
                        self.send_error(429, 'Lane budget boundary reached')
                        return
                context = request_context(self.path, root / 'current.json')
                responses_facade = self.path.endswith('/responses')
                if responses_facade:
                    # Judge transport only: the pinned SkillLearnBench skill metrics speak Responses.
                    # Keep their exact prompts/parsers, while explicitly substituting a DeepSeek judge.
                    prompt = body.get('input', '')
                    if not isinstance(prompt, str):
                        raise ValueError('Judge facade accepts plain-text inputs only')
                    body = {'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': prompt}],
                            'stream': False, 'max_tokens': body.get('max_output_tokens', 8192)}
                body.update(model='deepseek-flash', thinking={'type': 'enabled'}, reasoning_effort='high')
                if context.get('purpose') == 'judge':
                    body['thinking'] = {'type': 'disabled'}
                    body.pop('reasoning_effort', None)
                output_limit = body.pop('max_completion_tokens', body.get('max_tokens', 32768))
                body['max_tokens'] = min(int(output_limit), 32768)
                if body.get('stream'):
                    body['stream_options'] = {'include_usage': True}
                request = urllib.request.Request('https://api.deepseek.com/chat/completions',
                    data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
                response = urllib.request.urlopen(request, timeout=300)
                self.send_response(response.status)
                self.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
                self.end_headers()
                usage, actual_model, disconnected = None, None, False
                payload = b''
                # Read lines so SSE tokens reach the agent without waiting for a whole completion.
                for line in response:
                    if not disconnected and not responses_facade:
                        try:
                            self.wfile.write(line)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            disconnected = True
                    if body.get('stream'):
                        if line.startswith(b'data: ') and line.strip() != b'data: [DONE]':
                            event = json.loads(line[6:])
                            actual_model = event.get('model', actual_model)
                            if event.get('usage'):
                                usage = event['usage']
                    else:
                        payload += line
                if not body.get('stream'):
                    event = json.loads(payload)
                    usage, actual_model = event.get('usage'), event.get('model')
                    if responses_facade:
                        facade = {'id': event['id'], 'object': 'response', 'created_at': event.get('created', 0),
                                  'status': 'completed', 'model': actual_model,
                                  'output': [{'id': 'msg_judge', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                                              'content': [{'type': 'output_text', 'text': event['choices'][0]['message'].get('content') or '', 'annotations': []}]}],
                                  'usage': {'input_tokens': (usage or {}).get('prompt_tokens', 0),
                                            'output_tokens': (usage or {}).get('completion_tokens', 0),
                                            'total_tokens': (usage or {}).get('total_tokens', 0)}}
                        self.wfile.write(json.dumps(facade).encode())
                row = {**context, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'requestedModel': body['model'], 'model': actual_model, 'thinking': body['thinking'],
                    'reasoningEffort': body.get('reasoning_effort'), 'usage': usage, 'costCny': cost(usage) if usage else 0,
                    'usageMissing': usage is None, 'disconnected': disconnected}
                with lock:
                    spent += row['costCny']
                    with usage_file.open('a') as f:
                        f.write(json.dumps(row) + '\n')
            except urllib.error.HTTPError as error:
                # Never relay provider error text: some providers echo credentials.
                with (root / 'errors.jsonl').open('a') as f:
                    f.write(json.dumps({'type': 'ProviderHTTPError', 'status': error.code,
                                        'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}) + '\n')
                self.send_error(502, 'Provider HTTP ' + str(error.code))
            except Exception as error:
                with (root / 'errors.jsonl').open('a') as f:
                    f.write(json.dumps({'type': type(error).__name__, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}) + '\n')
                try:
                    self.send_error(502, 'Gateway request failed')
                except OSError:
                    pass

    http.server.ThreadingHTTPServer(('172.17.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--root', default='/srv/evimed/sb')
    p.add_argument('--key-file', default='/srv/evimed/secrets/deepseek.api-key')
    p.add_argument('--port', type=int, default=19412)
    p.add_argument('--cap', type=float, default=350)
    serve(p.parse_args())
