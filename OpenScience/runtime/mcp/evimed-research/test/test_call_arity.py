"""Every call the MCP server makes to one of its own functions can bind its arguments.

Nothing compiles these modules, so a call two arguments short is found only when
its line runs. One sat on the refusal path of `call_tool`: `failure(code,
message, False)` against five parameters. The refusal it was written to return
reached the caller as an anonymous "Internal error" instead (2026-10-03). A line
that runs only once something else has gone wrong is the line a test is least
likely to run, so the arity of all of them is read here from the syntax tree."""

import ast
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _signature(node, bound=0):
    """What a call must supply; `bound` drops `self` from a constructor."""
    names = [argument.arg for argument in node.args.posonlyargs + node.args.args][bound:]
    return {
        "names": names,
        "positional_only": len(node.args.posonlyargs[bound:]),
        "required": names[:len(names) - len(node.args.defaults)],
        "keyword_only": [argument.arg for argument in node.args.kwonlyargs],
        "keyword_required": [argument.arg for argument, default in zip(node.args.kwonlyargs, node.args.kw_defaults) if default is None],
        "var_positional": node.args.vararg is not None,
        "var_keyword": node.args.kwarg is not None,
    }


def _definitions(tree):
    """The module's own undecorated functions, and classes that define their constructor."""
    found = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.decorator_list:
            found[node.name] = _signature(node)
        elif isinstance(node, ast.ClassDef) and not node.decorator_list:
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "__init__" and not item.decorator_list:
                    found[node.name] = _signature(item, bound=1)
    for node in tree.body:
        # A name the module binds again is no longer the function defined above it.
        for target in getattr(node, "targets", []):
            if isinstance(target, ast.Name):
                found.pop(target.id, None)
    return found


def _problem(signature, call):
    """Why this call cannot bind, or None; a call that spreads `*` or `**` is not decidable here."""
    if any(isinstance(argument, ast.Starred) for argument in call.args) or any(keyword.arg is None for keyword in call.keywords):
        return None
    if len(call.args) > len(signature["names"]) and not signature["var_positional"]:
        return "takes %d positional arguments, given %d" % (len(signature["names"]), len(call.args))
    supplied = set(signature["names"][:len(call.args)])
    for keyword in call.keywords:
        known = keyword.arg in signature["names"][signature["positional_only"]:] or keyword.arg in signature["keyword_only"]
        if keyword.arg in supplied or not (known or signature["var_keyword"]):
            return "cannot take %s=" % keyword.arg
        supplied.add(keyword.arg)
    missing = [name for name in signature["required"] + signature["keyword_required"] if name not in supplied]
    return "is missing %s" % ", ".join(missing) if missing else None


def _local_names(function):
    """Names a function binds itself, which may hide a module-level function of the same name."""
    arguments = function.args
    names = {argument.arg for argument in arguments.posonlyargs + arguments.args + arguments.kwonlyargs}
    names |= {argument.arg for argument in (arguments.vararg, arguments.kwarg) if argument is not None}
    for node in ast.walk(function):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            names.add(node.id)
        elif node is not function and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
    return names


def unbindable_calls(root):
    """(calls checked, [calls that cannot bind]) across the modules in one directory."""
    modules = {}
    for path in sorted(root.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
        modules[path.stem] = (path, tree, _definitions(tree))
    checked, problems = 0, []
    for path, tree, own in modules.values():
        functions, siblings = dict(own), {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module in modules:
                for alias in node.names:
                    if alias.name in modules[node.module][2]:
                        functions.setdefault(alias.asname or alias.name, modules[node.module][2][alias.name])
            elif isinstance(node, ast.Import):
                siblings.update({alias.asname or alias.name: alias.name for alias in node.names if alias.name in modules})

        def visit(node, hidden):
            nonlocal checked
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                hidden = hidden | _local_names(node)
            if isinstance(node, ast.Call):
                target = None
                if isinstance(node.func, ast.Name) and node.func.id in functions and node.func.id not in hidden:
                    target = node.func.id, functions[node.func.id]
                elif (isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                      and node.func.value.id in siblings and node.func.value.id not in hidden
                      and node.func.attr in modules[siblings[node.func.value.id]][2]):
                    target = ("%s.%s" % (node.func.value.id, node.func.attr),
                              modules[siblings[node.func.value.id]][2][node.func.attr])
                if target is not None:
                    checked += 1
                    problem = _problem(target[1], node)
                    if problem:
                        problems.append("%s:%d %s() %s" % (path.name, node.lineno, target[0], problem))
            for child in ast.iter_child_nodes(node):
                visit(child, hidden)

        visit(tree, frozenset())
    return checked, problems


class CallArityTests(unittest.TestCase):
    def test_every_call_to_the_server_s_own_functions_can_bind(self):
        checked, problems = unbindable_calls(ROOT)
        # The walk has to have read the calls it is about: `failure` alone is
        # called from more than a hundred places in these modules.
        self.assertGreater(checked, 1500)
        self.assertEqual(problems, [])

    def test_the_check_reports_the_calls_that_were_wrong(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "results.py").write_text(
                "def failure(code, message, retryable, stop_reason, next_actions):\n    return code\n\n"
                "class Refusal(Exception):\n    def __init__(self, code, message, retryable=False):\n        self.code = code\n", encoding="utf-8")
            (root / "tool.py").write_text(
                "import results\nfrom results import Refusal, failure\n\n"
                "def refuse():\n    return failure('context_invalid', 'The context is invalid.', False)\n\n"
                "def complete(arguments):\n    failure(*arguments)\n    Refusal('code', 'message', True)\n"
                "    return results.failure('code', 'message', False, 'Stop.', ['Go on.'], extra=1)\n\n"
                "def hidden(failure):\n    return failure('a callable the caller passed in')\n\n"
                "def raises():\n    raise Refusal('code')\n", encoding="utf-8")
            checked, problems = unbindable_calls(root)
        self.assertEqual(checked, 5)
        self.assertEqual(problems, [
            "tool.py:5 failure() is missing stop_reason, next_actions",
            "tool.py:10 results.failure() cannot take extra=",
            "tool.py:16 Refusal() is missing message",
        ])


if __name__ == "__main__":
    unittest.main()
