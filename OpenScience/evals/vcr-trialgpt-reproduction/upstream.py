"""Load only the pinned upstream pure functions, without executing SDK initialization."""
import ast
import hashlib
from pathlib import Path

PIN = '1b3242cd50c153a9c324661d4a0bd94fc68a4226'
BLOB = 'fe2ecbc02eb700ea2cab9db5a3aa937e0e2f419c'
NAMES = {'parse_criteria', 'print_trial', 'get_matching_prompt'}


def load(path):
    source = Path(path).read_bytes()
    # The initial text-tool capture added a trailing blank line. Permit only
    # trailing-newline differences from the independently verified Git blob.
    canonical = source.rstrip(b'\n') + b'\n'
    if hashlib.sha1(b'blob ' + str(len(canonical)).encode() + b'\0' + canonical).hexdigest() != BLOB:
        raise ValueError('Upstream source differs from the pinned official blob')
    tree = ast.parse(source)
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in NAMES]
    if {n.name for n in nodes} != NAMES:
        raise ValueError('Upstream functions missing')
    scope = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), scope)
    return scope, hashlib.sha256(source).hexdigest()
