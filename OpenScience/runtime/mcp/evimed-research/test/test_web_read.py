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


def long_article(sections=8, paragraphs=6):
    """Markdown-shaped text (what the gateway's extractor writes) of ~50,000 characters: an H1, then sections of H2/H3."""
    parts = ["# A long review article", "Abstract. " + "Background and aim of the review. " * 8]
    for section in range(1, sections + 1):
        parts.append("## Section %d" % section)
        for paragraph in range(1, paragraphs + 1):
            if paragraph == 4:
                parts.append("### Section %d detail" % section)
            parts.append("Paragraph %d.%d. %s" % (section, paragraph, "The effect was consistent across the subgroups studied. " * 20))
    return "\n\n".join(parts)


class GatewayCase(unittest.TestCase):
    """The gateway played by a local server, and a workspace of its own for each test."""

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


class WebReadTests(GatewayCase):
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
        self.assertEqual(result["sources"][0]["artifactPath"], path)
        self.assertNotIn("official", result["sources"][0], "the official flag is data, not provenance")
        page = snapshot.decode("utf-8")
        for line in ("# 公告通告", "- Source: " + url, "- Official source: yes", "- Rendered in a browser before reading: yes", "- SHA-256: " + sha):
            self.assertIn(line + "\n", page)
        self.assertIn(text, page)
        # No retrieval time in the snapshot: the same bytes are the same capture.
        self.assertNotIn("2026-09-20T02:00", page)

    def test_a_read_passes_the_servers_own_tool_result_contract(self):
        # The tool is called through `call_tool`, which validates provenance.
        # This module's tests used to call `web_read.read` directly, so a source
        # field the contract refuses failed every production read and no test.
        url = "https://www.chictr.org.cn/showproj.html?proj=1"
        sha = hashlib.sha256(b"registry page").hexdigest()
        server = load_server()
        for title in ("公告通告", "", None):
            web_read._SNAPSHOTS.clear()
            Gateway.answers[url] = (200, {"receipt": receipt(url, sha, title=title), "text": "注册题目：推拿治疗小儿疳积", "links": []})
            with self.subTest(title=title):
                result = server.call_tool("web_read", {"url": url})
                self.assertEqual(result["status"], "success", result)
                self.assertEqual(result["sources"][0]["source"], "web-page")
                self.assertTrue(result["sources"][0]["artifactPath"].startswith(".evimed-sources/web-pages/"))
                self.assertEqual("title" in result["sources"][0], bool(title))
        # A long page adds an outline and a next action to a success; the contract admits both.
        web_read._SNAPSHOTS.clear()
        Gateway.answers[url] = (200, {"receipt": receipt(url, sha), "text": long_article(), "links": []})
        long_result = server.call_tool("web_read", {"url": url})
        self.assertEqual(long_result["status"], "success", long_result)
        self.assertTrue(long_result["data"]["outline"])
        self.assertTrue(long_result["next_actions"])

    def test_long_text_is_paged_from_one_snapshot(self):
        url = "https://www.escardio.org/Guidelines/hf.pdf"
        paragraphs = ["Recommendation %d. %s" % (index, "Offer the therapy to eligible patients. " * 40) for index in range(1, 30)]
        text = "\n\n".join(paragraphs)
        Gateway.answers[url] = (200, {"receipt": receipt(url, "b" * 64, contentType="document", mediaType="application/pdf"), "text": text, "links": []})
        first = web_read.read({"url": url})
        self.assertGreater(first["data"]["pages"], 2)
        self.assertEqual(first["data"]["nextPage"], 2)
        # Page 1 of a long text shows its opening only (see LongPageReadingMapTests) and page 2 continues where it ends.
        joined = [first["data"]["content"]]
        for page in range(2, first["data"]["pages"] + 1):
            result = web_read.read({"url": url, "page": page})
            self.assertEqual(result["data"]["markdownPath"], first["data"]["markdownPath"])
            self.assertLessEqual(len(result["data"]["content"]), web_read.PAGE_CHARS)
            joined.append(result["data"]["content"])
        self.assertIsNone(result["data"]["nextPage"])
        self.assertEqual("\n\n".join(joined), text, "pages are the text, split at paragraph boundaries and nothing lost, the opening included")
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

    def test_a_page_read_through_deepseek_fetch_is_preserved_as_its_rendition(self):
        # The gateway's second reader (2026-10-17): the receipt says so, and so does every reader of the file after it.
        url = "https://openai.example.org/index/"
        rendition = "# Index\n\nThe model is served by DeepSeek-V4.1-Flash-1017."
        sha = hashlib.sha256(rendition.encode("utf-8")).hexdigest()
        Gateway.answers[url] = (200, {"receipt": receipt(
            url, sha, rendered=False, official=False, contentType="text", mediaType="text/markdown",
            extractor={"name": "deepseek-fetch", "version": "1"}, via="deepseek-fetch", fallbackReason="site_403",
        ), "text": rendition, "links": []})
        server = load_server()
        result = server.call_tool("web_read", {"url": url})
        self.assertEqual(result["status"], "success", "a rendition is a reading, not a failure")
        self.assertEqual(result["data"]["via"], "deepseek-fetch")
        self.assertIn(web_read.RENDITION_WARNING, result["warnings"])
        path = result["data"]["markdownPath"]
        snapshot = (self.workspace / path).read_bytes()
        page = snapshot.decode("utf-8")
        header = "\n" + page.split("\n\n", 2)[1] + "\n"
        self.assertIn("\n" + web_read.RENDITION_LINE + "\n", header, "the line is in the header, before the page's text")
        self.assertIn("- Read as: plain text (text/markdown; deepseek-fetch 1)\n", page)
        self.assertIn("- SHA-256: " + sha + "\n", page)
        self.assertIn(rendition, page)
        # The preserved-source rule binds this file exactly as any other: the digest the run's record checks is the file's.
        self.assertEqual(result["data"]["artifactSha256s"], {path: hashlib.sha256(snapshot).hexdigest()})
        self.assertEqual(result["sources"][0]["source"], "web-page")
        self.assertNotIn("via", result["sources"][0], "provenance fields stay the contract's; the label is data")
        # The domain's claim check reads the line character for character.
        domain = (ROOT.parents[2] / "packages" / "domain" / "src" / "clinicalEvidence.mjs").read_text(encoding="utf-8")
        self.assertIn(json.dumps(web_read.RENDITION_LINE), domain)

        direct = "https://direct.example.org/p"
        Gateway.answers[direct] = (200, {"receipt": receipt(direct, "e" * 64), "text": "Direct text.", "links": []})
        plain = web_read.read({"url": direct})
        self.assertNotIn("via", plain["data"])
        self.assertNotIn("warnings", plain)
        self.assertNotIn(web_read.RENDITION_LINE, (self.workspace / plain["data"]["markdownPath"]).read_text(encoding="utf-8"))

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


class LongPageReadingMapTests(GatewayCase):
    """A text longer than one page does not flood the context on its first read (2026-10-28: ~44,000 characters of a PMC page).

    Page 1 carries the opening (HEAD_CHARS, cut at a paragraph) and an outline of the preserved file; the preserved
    snapshot, the digest, the sources and `page=N` are what they were.
    """

    URL = "https://pmc.example.org/articles/PMC123/"

    def read_long(self, text=None, **extra):
        text = long_article() if text is None else text
        Gateway.answers[self.URL] = (200, {"receipt": receipt(self.URL, "f" * 64, official=False), "text": text, **extra})
        return text, web_read.read({"url": self.URL})

    def test_the_first_page_is_the_opening_and_an_outline_of_the_saved_file(self):
        text, result = self.read_long()
        self.assertGreater(len(text), 3 * web_read.PAGE_CHARS)
        data = result["data"]
        self.assertEqual(result["status"], "success")
        # The opening: at most 6,000 characters of the text, ending where a paragraph ends.
        self.assertLessEqual(len(data["content"]), web_read.HEAD_CHARS)
        self.assertGreater(len(data["content"]), web_read.HEAD_CHARS // 2)
        self.assertTrue(text.startswith(data["content"] + "\n\n"), "cut at a paragraph boundary")
        # The outline points into the preserved file: `read` with offset=line finds the heading there.
        file_lines = (self.workspace / data["markdownPath"]).read_text(encoding="utf-8").split("\n")
        self.assertEqual(data["fileLines"], len(file_lines))
        headings = [entry["heading"] for entry in data["outline"]]
        self.assertEqual(headings[:3], ["公告通告", "A long review article", "Section 1"], "the file's own title line, then the text's headings")
        for entry in data["outline"]:
            self.assertEqual(file_lines[entry["line"] - 1].lstrip("# ").strip(), entry["heading"])
            self.assertGreaterEqual(entry["lines"], 1)
        self.assertEqual([entry["level"] for entry in data["outline"] if entry["heading"].startswith("Section 1")], [2, 3])
        # A section's length is what its lines add up to, so a run can size a read before making it.
        section = next(entry for entry in data["outline"] if entry["heading"] == "Section 2")
        at = data["outline"].index(section)
        self.assertEqual(section["line"] + section["lines"], data["outline"][at + 1]["line"], "a section runs to the next heading")
        self.assertEqual(section["characters"], sum(len(line) + 1 for line in file_lines[section["line"] - 1:section["line"] - 1 + section["lines"]]))
        # What the model is told to do next.
        self.assertEqual(len(result["next_actions"]), 1)
        advice = result["next_actions"][0]
        for needle in (data["markdownPath"], "read", "offset", "locate_quote", "page=2", "where this opening ends", str(web_read.PAGE_CHARS)):
            self.assertIn(needle, advice)
        self.assertIn("first %d" % len(data["content"]), result["summary"])
        self.assertNotIn("warnings", result)

    def test_the_preserved_record_the_digest_and_the_sources_are_what_they_were(self):
        text, result = self.read_long(links=[{"text": "Next", "url": "https://pmc.example.org/next"}])
        data = result["data"]
        path = data["markdownPath"]
        snapshot = (self.workspace / path).read_bytes()
        self.assertIn(text.encode("utf-8"), snapshot, "the whole text is preserved, whatever the result shows")
        self.assertEqual(data["artifactSha256s"], {path: hashlib.sha256(snapshot).hexdigest()})
        self.assertEqual((data["sha256"], data["sourceId"]), ("f" * 64, "web-page:" + "f" * 16))
        self.assertEqual(data["characters"], len(text))
        self.assertEqual(result["artifacts"], [path])
        self.assertEqual(result["sources"][0]["artifactPath"], path)
        self.assertEqual(result["sources"][0]["id"], "web-page:" + "f" * 16)
        self.assertEqual(data["links"], [{"text": "Next", "url": "https://pmc.example.org/next"}])
        pages = web_read.reading_pages(text)
        self.assertEqual((data["page"], data["pages"], data["nextPage"]), (1, len(pages), 2))

    def test_page_2_starts_where_the_opening_ended_and_no_text_goes_unreturned(self):
        # Page 1 showed the opening (as little as ~3,000 characters) while page 2 started at the 12,000th: the text between was
        # in no page at all, and the run was told page 2 was the continuation (review of 2026-10-28).
        text, first = self.read_long()
        opening = first["data"]["content"]
        self.assertLess(len(opening), web_read.PAGE_CHARS // 2)
        second = web_read.read({"url": self.URL, "page": 2})
        self.assertTrue(text.startswith(opening + "\n\n" + second["data"]["content"][:200]), "page 2 begins right after the opening")
        contents = [opening, second["data"]["content"]]
        for page in range(3, first["data"]["pages"] + 1):
            contents.append(web_read.read({"url": self.URL, "page": page})["data"]["content"])
        for content in contents[1:]:
            self.assertLessEqual(len(content), web_read.PAGE_CHARS)
        collapse = lambda value: "".join(value.split())
        self.assertEqual(collapse("".join(contents)), collapse(text), "every character of the text is returned by exactly one page")
        # The gap itself: the first paragraph past the opening is in page 2, not skipped.
        paragraph = text[len(opening):].lstrip("\n").split("\n\n")[0]
        self.assertIn(paragraph, second["data"]["content"])
        self.assertEqual(len(Gateway.requests), 1, "from the snapshot, not the site again")

    def test_page_n_returns_slices_of_the_rest_without_an_outline(self):
        text, first = self.read_long()
        pages = web_read.reading_pages(text)
        self.assertEqual(pages[0], first["data"]["content"])
        second = web_read.read({"url": self.URL, "page": 2})
        self.assertEqual(second["data"]["content"], pages[1])
        self.assertNotIn("outline", second["data"])
        self.assertNotIn("next_actions", second)
        self.assertEqual(second["data"]["markdownPath"], first["data"]["markdownPath"])
        self.assertEqual(len(Gateway.requests), 1, "from the snapshot, not the site again")

    def test_a_text_that_fits_one_page_is_unchanged(self):
        for size in (web_read.PAGE_CHARS - 1, web_read.PAGE_CHARS):
            with self.subTest(size=size):
                text = ("# Short\n\n" + "x" * size)[:size]
                _text, result = self.read_long(text)
                data = result["data"]
                self.assertEqual((data["content"], data["pages"], data["nextPage"]), (text, 1, None))
                for key in ("outline", "fileLines", "outlineHeadings"):
                    self.assertNotIn(key, data)
                self.assertNotIn("next_actions", result)
                self.assertNotIn("first", result["summary"])
        _text, result = self.read_long("y" * (web_read.PAGE_CHARS + 1))
        self.assertIn("outline", result["data"], "one character past a page is a long text")

    def test_a_long_text_without_headings_still_says_how_to_read_it(self):
        text = "\n".join("Line %d of a long run of plain text without a heading in it." % index for index in range(1, 600))
        _text, result = self.read_long(text)
        data = result["data"]
        self.assertEqual([entry["heading"] for entry in data["outline"]], ["公告通告"])
        self.assertEqual(len(data["outline"]), 1, "only the file's own title line")
        self.assertGreater(data["fileLines"], 600)
        self.assertLessEqual(len(data["content"]), web_read.HEAD_CHARS)
        self.assertTrue(text.startswith(data["content"]), "cut at a line when there is no paragraph break")
        self.assertIn(data["markdownPath"], result["next_actions"][0])

    def test_the_outline_is_a_table_of_contents_and_says_when_it_is_cut(self):
        text = "\n\n".join("## Heading %03d\n\nSome text under it. " % index + "More. " * 30 for index in range(1, 101))
        _text, result = self.read_long(text)
        data = result["data"]
        self.assertEqual(len(data["outline"]), web_read.MAX_OUTLINE_ENTRIES)
        self.assertEqual(data["outlineHeadings"], 101, "the 100 headings and the file's title line")
        self.assertEqual(data["outline"][1]["heading"], "Heading 001")

    def test_an_incomplete_page_notice_and_the_reading_advice_both_arrive(self):
        _text, result = self.read_long(notice="this text may be incomplete")
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["warnings"], ["this text may be incomplete"])
        self.assertEqual(len(result["next_actions"]), 2)
        self.assertIn("locate_quote", result["next_actions"][0])
        self.assertEqual(result["next_actions"][1], "Prefer another source for anything the page may have left out.")

    def test_head_of_cuts_at_a_paragraph_then_a_line_then_hard_and_never_leaves_a_stub(self):
        paragraphs = "\n\n".join(["p" * 2000] * 5)
        self.assertEqual(web_read.head_of(paragraphs, 6000), "\n\n".join(["p" * 2000] * 2), "the last whole paragraph inside the limit")
        self.assertEqual(web_read.head_of("short", 6000), "short")
        lines = "\n".join(["l" * 100] * 100)
        self.assertEqual(web_read.head_of(lines, 6000), "\n".join(["l" * 100] * 59))
        stub = "a" * 100 + "\n\n" + "b" * 10_000
        self.assertEqual(len(web_read.head_of(stub, 6000)), 6000, "a boundary in the first half would leave a stub")
        self.assertEqual(web_read.head_of("z" * 20_000, 6000), "z" * 6000)


if __name__ == "__main__":
    unittest.main()
