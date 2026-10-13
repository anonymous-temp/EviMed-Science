"""What a model is told when open-web search is not enabled: it can read a page it has an address for, the literature databases are named
only as one option for published literature, and it is asked to say plainly that search was unavailable. Release 18's baseline (G14): the
old sentence told a tax question to continue with PubMed."""
import importlib.util
import os
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_websearch", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WebSearchUnavailable(unittest.TestCase):
    def test_what_a_run_receives_is_neutral_about_where_to_look_next(self):
        with mock.patch.dict(os.environ, {"EVIMED_WEB_SEARCH_GATEWAY_URL": ""}):
            result = load_server().call_tool("web_search", {"query": "个人所得税专项附加扣除 2026"})
        self.assertEqual(result["error"]["code"], "web_search_unconfigured")
        self.assertIn("web_read", result["summary"])
        said = " ".join([result["summary"], *result["next_actions"]])
        self.assertIn("for published literature the bibliographic databases are one option", said)
        self.assertIn("Say plainly that search was unavailable", said)
        for old in ("continue with the bibliographic channels", "remain available"):
            self.assertNotIn(old, said)


if __name__ == "__main__":
    unittest.main()
