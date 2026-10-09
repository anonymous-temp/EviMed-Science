import assert from "node:assert/strict";
import test from "node:test";
import { citedDomain, countsOf, pageKey, pagesCited, tallySources } from "../src/geoSourceAnswers.mjs";

/** @param {string} id @param {any[]} citations @param {Partial<{ engine: string, wrongOurs: boolean, mentionsOurs: boolean }>} [more] */
const answer = (id, citations, more = {}) => ({ id, engine: "deepseek", pool: "P1", questionId: "q", askedAt: null, citations, mentionsOurs: false, wrongOurs: false, ...more });

test("a page is its address without the fragment, the scheme, a leading www. and a trailing slash — and with its query", () => {
  assert.equal(pageKey("https://www.News.Example.org/a/#top"), "news.example.org/a");
  assert.equal(pageKey("http://news.example.org/a/"), "news.example.org/a");
  assert.equal(pageKey("https://news.example.org/s?id=2"), "news.example.org/s?id=2");
  assert.notEqual(pageKey("https://news.example.org/s?id=2"), pageKey("https://news.example.org/s?id=3"));
  assert.equal(pageKey("https://news.example.org"), "news.example.org");
  assert.equal(pageKey("https://news.example.org/?x=1"), "news.example.org?x=1");
  assert.equal(pageKey(""), "");
});

test("the pages of a site: once per answer however many links it carries, the commonest title, most cited first, the others' pages left out", () => {
  const news = (path, title = "") => ({ url: `https://www.news.example.org${path}`, domain: "www.news.example.org", title });
  const answers = [
    answer("a1", [news("/a", "指南"), news("/a#x", "指南解读"), news("/b")], { wrongOurs: true }),
    answer("a2", [news("/a", "指南解读"), { url: "https://other.example.org/z", domain: "other.example.org", title: "别人" }]),
    answer("a3", [news("/c", "")]),
    answer("a4", [{ url: "", domain: "news.example.org", title: "没有链接" }]),
  ];
  const { pages, total } = pagesCited(answers, "News.Example.org");
  assert.equal(total, 3);
  assert.deepEqual(pages, [
    { url: "https://www.news.example.org/a", title: "指南解读", cited: 2, wrongOurs: 1 },
    { url: "https://www.news.example.org/b", title: null, cited: 1, wrongOurs: 1 },
    { url: "https://www.news.example.org/c", title: null, cited: 1, wrongOurs: 0 },
  ]);
  assert.deepEqual(pagesCited(answers, "news.example.org", { limit: 1 }).pages.map((page) => page.url), ["https://www.news.example.org/a"]);
  assert.equal(pagesCited(answers, "news.example.org", { limit: 1 }).total, 3, "the count says how many there were");
  assert.deepEqual(pagesCited([], "news.example.org"), { pages: [], total: 0 });
});

test("the counts of the answers that cite a site are the row's tally over them", () => {
  const cite = [{ url: "https://news.example.org/a", domain: "news.example.org" }];
  const answers = [
    answer("a1", cite, { wrongOurs: true, mentionsOurs: true }),
    answer("a2", cite, { engine: "kimi", mentionsOurs: true }),
    answer("a3", [{ url: "https://x.org", domain: "x.org" }], { wrongOurs: true }),
  ];
  assert.deepEqual(countsOf(answers.slice(0, 2), "news.example.org"), { cited: 2, wrongOurs: 1, mentionsOurs: 2 });
  assert.deepEqual(countsOf([], "news.example.org"), { cited: 0, wrongOurs: 0, mentionsOurs: 0 });
  assert.deepEqual(countsOf(answers, "news.example.org"), { cited: 2, wrongOurs: 1, mentionsOurs: 2 }, "an answer that does not cite the site is not counted");
  assert.equal(tallySources(answers).get("news.example.org")?.byEngine.kimi.cited, 1);
  assert.equal(citedDomain({ domain: "WWW.News.Example.org" }), "news.example.org");
});
