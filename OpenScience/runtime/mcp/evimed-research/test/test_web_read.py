"""`web_read`: one public page through the gateway, preserved with its receipt.

The gateway is played by a small HTTP server in this process, so what is
tested is the request the runtime actually sends and what it does with the
answer: the snapshot on disk, the paging, and the gateway's refusals passed
through by name.
"""

import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import web_read  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_web_read", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def receipt(url, sha, **extra):
    return {
        "url": url, "finalUrl": url, "title": "公告通告", "site": "www.nmpa.gov.cn", "fetchedAt": "2026-09-20T02:00:00.000Z",
        "official": True, "rendered": True, "contentType": "html", "mediaType": "text/html", "status": 200,
        "sha256": sha, "bytes": 4096, "extractor": {"name": "evimed-html", "version": "1.0.0"}, **extra,
    }


class Gateway(http.server.BaseHTTPRequestHandler):
    answers = {}
    requests = []

    def do_POST(self):  # noqa: N802 - the stdlib's name
        body = json.loads(self.rfile.read(int(self.headers["content-length"])).decode("utf-8"))
        Gateway.requests.append({"body": body, "authorization": self.headers.get("authorization")})
        status, payload = Gateway.answers[body["webRead"]["url"]]
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        return


class WebReadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.workspace = root / "workspace"
        self.workspace.mkdir()
        token = root / "gateway.token"
        token.write_text("runtime-token\n", encoding="utf-8")
        os.chmod(token, 0o600)
        self.saved = {name: os.environ.get(name) for name in (
            "OPEN_SCIENCE_WORKSPACE_DIR", "EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "EVIMED_MODEL_GATEWAY_TOKEN_FILE", "EVIMED_MODEL_CONFIG_FILE",
        )}
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(self.workspace)
        os.environ["EVIMED_PUBLIC_SOURCE_GATEWAY_URL"] = "http://127.0.0.1:%d/internal/sources/v1/fetch" % self.server.server_address[1]
        os.environ["EVIMED_MODEL_GATEWAY_TOKEN_FILE"] = str(token)
        os.environ.pop("EVIMED_MODEL_CONFIG_FILE", None)
        Gateway.answers = {}
        Gateway.requests = []
        web_read._SNAPSHOTS.clear()

    def tearDown(self):
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self.temp.cleanup()

    def test_a_page_is_read_through_the_gateway_and_preserved_with_its_receipt(self):
        url = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html"
        text = "\n\n".join("- 国家药监局关于第%d号的公告 2026-09-%02d" % (index, index % 28 + 1) for index in range(1, 30))
        sha = hashlib.sha256(b"rendered html").hexdigest()
        Gateway.answers[url] = (200, {
            "receipt": receipt(url, sha),
            "text": text,
            "links": [{"text": "国家药监局关于第1号的公告", "url": "https://www.nmpa.gov.cn/xxgk/ggtg/1.html"}, {"text": "bad", "url": "javascript:void(0)"}],
        })
        result = web_read.read({"url": url})
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(Gateway.requests, [{"body": {"webRead": {"url": url}}, "authorization": "Bearer runtime-token"}])
        data = result["data"]
        self.assertEqual((data["official"], data["rendered"], data["sha256"], data["site"]), (True, True, sha, "www.nmpa.gov.cn"))
        self.assertEqual((data["page"], data["pages"], data["nextPage"]), (1, 1, None))
        self.assertEqual(data["content"], text)
        self.assertEqual(data["links"], [{"text": "国家药监局关于第1号的公告", "url": "https://www.nmpa.gov.cn/xxgk/ggtg/1.html"}])
        path = data["markdownPath"]
        self.assertTrue(path.startswith(".evimed-sources/web-pages/%s/" % sha[:16]), path)
        snapshot = (self.workspace / path).read_bytes()
        self.assertEqual(data["artifactSha256s"], {path: hashlib.sha256(snapshot).hexdigest()})
        self.assertEqual(result["artifacts"], [path])
        self.assertEqual(result["sources"][0]["id"], "web-page:" + sha[:16])
        self.assertEqual(result["sources"][0]["official"], True)
        page = snapshot.decode("utf-8")
        for line in ("# 公告通告", "- Source: " + url, "- Official source: yes", "- Rendered in a browser before reading: yes", "- SHA-256: " + sha):
            self.assertIn(line + "\n", page)
        self.assertIn(text, page)
        # No retrieval time in the snapshot: the same bytes are the same capture.
        self.assertNotIn("2026-09-20T02:00", page)

    def test_long_text_is_paged_from_one_snapshot(self):
        url = "https://www.escardio.org/Guidelines/hf.pdf"
        paragraphs = ["Recommendation %d. %s" % (index, "Offer the therapy to eligible patients. " * 40) for index in range(1, 30)]
        text = "\n\n".join(paragraphs)
        Gateway.answers[url] = (200, {"receipt": receipt(url, "b" * 64, contentType="document", mediaType="application/pdf"), "text": text, "links": []})
        first = web_read.read({"url": url})
        self.assertGreater(first["data"]["pages"], 2)
        self.assertEqual(first["data"]["nextPage"], 2)
        joined = [first["data"]["content"]]
        for page in range(2, first["data"]["pages"] + 1):
            result = web_read.read({"url": url, "page": page})
            self.assertEqual(result["data"]["markdownPath"], first["data"]["markdownPath"])
            self.assertLessEqual(len(result["data"]["content"]), web_read.PAGE_CHARS)
            joined.append(result["data"]["content"])
        self.assertIsNone(result["data"]["nextPage"])
        self.assertEqual("\n\n".join(joined), text, "pages are the text, split at paragraph boundaries and nothing lost")
        self.assertEqual(len(Gateway.requests), 1, "later pages come from the snapshot, not from the site again")
        beyond = web_read.read({"url": url, "page": first["data"]["pages"] + 1})
        self.assertEqual(beyond["error"]["code"], "web_read_page_out_of_range")

    def test_paging_is_a_pure_function_of_the_text(self):
        text = "a" * 30_000 + "\n\n" + "b" * 10 + "\nline\n" + "c" * 5
        self.assertEqual(web_read.pages_of(text), web_read.pages_of(text))
        self.assertTrue(all(len(page) <= web_read.PAGE_CHARS for page in web_read.pages_of(text)))
        self.assertEqual("".join(web_read.pages_of("a" * 30_000)), "a" * 30_000)
        self.assertEqual(web_read.pages_of(""), [""])

    def test_the_gateways_refusals_arrive_by_name(self):
        for url, status, code, retryable in (
            ("https://closed.example.org/p", 403, "web_read_robots_disallowed", False),
            ("https://www.cde.org.cn/x", 422, "web_read_needs_browser", False),
            ("https://busy.example.org/p", 429, "web_read_host_busy", True),
            ("https://slow.example.org/p", 504, "web_read_timeout", True),
        ):
            Gateway.answers[url] = (status, {"error": {"code": code, "message": "%s says no" % url}})
            result = web_read.read({"url": url})
            self.assertEqual(result["status"], "error")
            self.assertEqual((result["error"]["code"], result["error"]["retryable"]), (code, retryable), url)
            self.assertIn("says no", result["error"]["message"])
        self.assertEqual(list((self.workspace).glob(".evimed-sources/**/page.md")), [], "a refusal preserves nothing")

    def test_a_page_that_may_be_incomplete_is_a_warning(self):
        url = "https://thin.example.org/brief"
        Gateway.answers[url] = (200, {"receipt": receipt(url, "c" * 64, rendered=False, official=False), "text": "A short notice.", "links": [], "notice": "this text may be incomplete"})
        result = web_read.read({"url": url})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["warnings"], ["this text may be incomplete"])
        self.assertTrue((self.workspace / result["data"]["markdownPath"]).is_file())

    def test_the_same_bytes_at_two_addresses_keep_separate_snapshots(self):
        sha = "d" * 64
        for url in ("https://a.example.org/p", "https://b.example.org/p"):
            Gateway.answers[url] = (200, {"receipt": receipt(url, sha, official=False), "text": "Same text.", "links": []})
        first = web_read.read({"url": "https://a.example.org/p"})
        second = web_read.read({"url": "https://b.example.org/p"})
        again = web_read.read({"url": "https://a.example.org/p"})
        self.assertNotEqual(first["data"]["markdownPath"], second["data"]["markdownPath"])
        self.assertEqual(first["data"]["markdownPath"], again["data"]["markdownPath"], "re-reading the same bytes reuses the capture")

    def test_without_a_gateway_the_tool_says_so(self):
        os.environ.pop("EVIMED_PUBLIC_SOURCE_GATEWAY_URL")
        result = web_read.read({"url": "https://www.nice.org.uk/guidance/ng136"})
        self.assertEqual(result["error"]["code"], "web_read_unconfigured")
        self.assertEqual(web_read.read({"url": ""})["error"]["code"], "web_read_url_invalid")
        self.assertEqual(web_read.read({"url": "https://x.example.org", "page": 0})["error"]["code"], "web_read_page_invalid")

    def test_the_tool_is_registered_short_and_hidden_by_the_deployment_switch(self):
        server = load_server()
        tool = server.TOOLS["web_read"]
        self.assertLess(len(tool["description"]), 500, "the whole tool list rides every request (principle 16)")
        self.assertEqual(tool["inputSchema"]["required"], ["url"])
        self.assertIn("web_read", server.OPTIONAL_TOOLS)
        previous = os.environ.get("EVIMED_DISABLED_TOOLS")
        os.environ["EVIMED_DISABLED_TOOLS"] = "web_read"
        try:
            self.assertNotIn("web_read", {entry["name"] for entry in server.list_tools()})
        finally:
            if previous is None:
                os.environ.pop("EVIMED_DISABLED_TOOLS", None)
            else:
                os.environ["EVIMED_DISABLED_TOOLS"] = previous


if __name__ == "__main__":
    unittest.main()
