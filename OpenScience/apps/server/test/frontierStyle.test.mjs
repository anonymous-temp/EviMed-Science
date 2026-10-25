import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_GENRES } from "@evimed/domain";
import { isChineseProse } from "../src/frontierEditor.mjs";
import { FRONTIER_LEAD_MOVES, FRONTIER_SENTENCE_RULE, FRONTIER_STYLE_CARDS, FRONTIER_TITLE_RULE, frontierStyleExemplarTexts } from "../src/frontierStyle.mjs";

const sentences = (/** @type {string} */ text) => text.match(/[^。！？]+[。！？]?/gu)?.map((s) => s.trim()).filter(Boolean) ?? [];
// "95% CI" is a label, not a result; an effect and its interval count as the numbers they are.
const numbersIn = (/** @type {string} */ text) => (text.replace(/95\s*%\s*(?:CI|置信区间)/g, "").match(/\d+(?:[.,·]\d+)?/g) ?? []).length;

test("every genre has a style card: a title formula, a move order of the closed vocabulary, a paragraph and two exemplars", () => {
  for (const genre of FRONTIER_GENRES) {
    const card = FRONTIER_STYLE_CARDS[genre];
    assert.ok(card.title.length > 4 && isChineseProse(card.title), genre);
    assert.ok(card.moves.length >= 1 && card.moves.every((move) => move in FRONTIER_LEAD_MOVES), genre);
    assert.ok(card.lead.length > 20, genre);
    assert.equal(card.exemplars.length, 2, genre);
    for (const exemplar of card.exemplars) assert.match(exemplar.ref, /^[a-f0-9]{16}$/, `${genre}: the exemplar names the public item it was written on`);
  }
  assert.equal(frontierStyleExemplarTexts().length, FRONTIER_GENRES.length * 4);
});

test("the exemplars keep the rules they teach: a title under 40, one paragraph, short sentences, at most three numbers in one, no 分别 list, no dash", () => {
  for (const genre of FRONTIER_GENRES) {
    for (const { title, lead } of FRONTIER_STYLE_CARDS[genre].exemplars) {
      assert.ok([...title].length <= 40, `${genre}: ${title}`);
      assert.ok(!/[？?！!]|重磅|刚刚|突发|揭秘|【|】|丨|｜/.test(title), `${genre}: the title rule — ${title}`);
      assert.ok([...lead].length <= (genre === "social" ? 80 : 160), `${genre}: a 导读 above 要点 holds 160 (a post's 80)`);
      assert.ok(!/\n/.test(lead) && isChineseProse(lead), genre);
      assert.ok(!/分别|依次|—/.test(lead), `${genre}: ${lead}`);
      for (const sentence of sentences(lead)) {
        assert.ok([...sentence].length <= 80, `${genre}: ${sentence}`);
        assert.ok(numbersIn(sentence) <= 3, `${genre}: ${sentence}`);
      }
    }
  }
  assert.match(FRONTIER_SENTENCE_RULE, /一句只讲一件事/);
  assert.match(FRONTIER_TITLE_RULE, /不用问句和感叹号/);
});
