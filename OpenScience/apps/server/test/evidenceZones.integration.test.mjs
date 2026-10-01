import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { evidenceHash, evidenceContentHash, evidenceEditorialReceipt } from "../src/evidenceCardContent.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { withAccountExportSnapshot } from "../src/accountExport.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
let isolated, db, service;
const alice = { id: "alice" },
  bob = { id: "bob" };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "evidence");
  db = new ControlPlaneDatabase({
    databaseUrl: isolated.url,
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 2000,
  });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query(
    "INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development')",
  );
  service = new EvidenceZoneService({ database: db });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (db)
    await db.query(
      "TRUNCATE evimed_frontier.evidence_zones,evimed_frontier.items,evimed_frontier.sources CASCADE",
    );
});
const zoneInput = {
  title: "Cardiology",
  description: "Evidence for practice",
  background: "Clinical questions",
};
const cardInput = {
  title: "A trial",
  subtype: "academic",
  summary: "Trial summary",
  body: "The trial describes observed outcomes.",
  sources: [
    {
      title: "Trial source",
      url: "https://example.org/trial",
      excerpt: "Observed outcomes",
    },
  ],
  limitations: "Study population",
  provenance: "Authored synthesis",
};
const createZone = async (user = alice, published = true) => {
  const { zone } = await service.save(user, zoneInput);
  return published
    ? (
        await service.save(
          user,
          { expectedRevision: zone.revision, state: "published" },
          zone.id,
        )
      ).zone
    : zone;
};
const createCard = async (zone, user = alice, fields = {}) => {
  const { evidence } = await service.save(
    user,
    { ...cardInput, ...fields },
    zone.id,
    null,
    true,
  );
  return evidence;
};
const publish = async (zone, card, user = alice) =>
  (
    await service.save(
      user,
      { expectedRevision: card.revision, state: "published" },
      zone.id,
      card.id,
    )
  ).evidence;

test(
  "follows preserve public cursors and invalidate only changed following membership",
  options,
  async () => {
    const zones = [await createZone(), await createZone(), await createZone()];
    const params = new URLSearchParams({ limit: "1" });
    const publicPage = await service.list(bob, params);
    await service.act(bob, zones[0].id, "follow", {
      expectedRevision: zones[0].revision,
    });
    assert.equal(
      (
        await service.list(
          bob,
          new URLSearchParams({ limit: "1", cursor: publicPage.nextCursor }),
        )
      ).total,
      3,
    );
    await service.act(bob, zones[1].id, "follow", {
      expectedRevision: zones[1].revision,
    });
    const following = await service.list(
      bob,
      new URLSearchParams({ scope: "following", limit: "1" }),
    );
    await service.act(alice, zones[2].id, "follow", {
      expectedRevision: zones[2].revision,
    });
    assert.equal(
      (
        await service.list(
          bob,
          new URLSearchParams({
            scope: "following",
            limit: "1",
            cursor: following.nextCursor,
          }),
        )
      ).total,
      2,
    );
    await service.act(bob, zones[2].id, "follow", {
      expectedRevision: zones[2].revision,
    });
    await assert.rejects(
      service.list(
        bob,
        new URLSearchParams({
          scope: "following",
          limit: "1",
          cursor: following.nextCursor,
        }),
      ),
      { code: "evidence_cursor_invalid" },
    );
  },
);

test(
  "drafts stay owned; published cards never escape a private zone; creator fields are immutable",
  options,
  async () => {
    const zone = await createZone(alice, false),
      card = await createCard(zone);
    assert.equal((await service.list(bob, new URLSearchParams())).total, 0);
    await assert.rejects(service.detail(bob, zone.id), {
      code: "evidence_not_found",
    });
    const published = await publish(zone, card);
    assert.equal(published.canResearch, false);
    await assert.rejects(service.detail(bob, zone.id, published.id), {
      code: "evidence_not_found",
    });
    const live = (
      await service.save(
        alice,
        { expectedRevision: zone.revision, state: "published" },
        zone.id,
      )
    ).zone;
    assert.equal(
      (await service.detail(bob, live.id, published.id)).evidence.creator,
      "Alice",
    );
    await assert.rejects(
      service.save(
        bob,
        { title: "Stolen", expectedRevision: live.revision },
        live.id,
      ),
      { code: "evidence_owner_required" },
    );
    await assert.rejects(
      service.save(
        alice,
        { creator: "Bob", expectedRevision: published.revision },
        live.id,
        published.id,
      ),
      { code: "evidence_invalid" },
    );
    await service.save(
      alice,
      { expectedRevision: live.revision, state: "draft" },
      live.id,
    );
    await assert.rejects(service.detail(bob, live.id, published.id), {
      code: "evidence_not_found",
    });
  },
);

test(
  "publication has source/content requirements and validated links without remote fetching",
  options,
  async () => {
    const zone = await createZone();
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://test-user:test-only-password@example.org/",
    ])
      await assert.rejects(
        createCard(zone, alice, { sources: [{ title: "Unsafe", url }] }),
        { code: "evidence_invalid" },
      );
    const incomplete = await createCard(zone, alice, { body: "", sources: [] });
    await assert.rejects(publish(zone, incomplete), {
      code: "evidence_publication_incomplete",
    });
    const good = await createCard(zone);
    const visible = await publish(zone, good);
    assert.equal(visible.reviewer, null);
    assert.equal(visible.review, null);
    assert.equal((await service.detail(bob, zone.id)).zone.evidenceCount, 1);
  },
);

test(
  "corpus searches count and paginate matching published rows, with scope-bound current cursors",
  options,
  async () => {
    const zone = await createZone();
    for (let n = 0; n < 4; n++)
      await publish(
        zone,
        await createCard(zone, alice, {
          title: `Trial ${n}`,
          body: n % 2 ? "needle evidence" : "other evidence",
        }),
      );
    await createCard(zone, alice, { title: "Hidden needle", body: "needle" });
    const params = new URLSearchParams({ q: "needle", limit: "1" });
    const first = await service.list(bob, params, zone.id);
    assert.equal(first.total, 2);
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await service.list(
      bob,
      new URLSearchParams({
        q: "needle",
        limit: "1",
        cursor: first.nextCursor,
      }),
      zone.id,
    );
    assert.equal(second.total, 2);
    assert.notEqual(second.items[0].id, first.items[0].id);
    assert.equal(second.nextCursor, null);
    await assert.rejects(
      service.list(
        alice,
        new URLSearchParams({
          q: "needle",
          limit: "1",
          cursor: first.nextCursor,
        }),
        zone.id,
      ),
      { code: "evidence_cursor_invalid" },
    );
    await createCard(zone);
    await assert.rejects(
      service.list(
        bob,
        new URLSearchParams({
          q: "needle",
          limit: "1",
          cursor: first.nextCursor,
        }),
        zone.id,
      ),
      { code: "evidence_cursor_invalid" },
    );
    const owned = await service.list(
      alice,
      new URLSearchParams({ scope: "owned", q: "needle" }),
      zone.id,
    );
    assert.equal(owned.total, 3);
  },
);

test(
  "source search matches preserved content without matching internal JSON field names",
  options,
  async () => {
    const zone = await createZone();
    const card = await publish(zone, await createCard(zone));
    assert.equal(
      (await service.list(bob, new URLSearchParams({ q: "excerpt" }), zone.id))
        .total,
      0,
    );
    assert.equal(
      (await service.list(bob, new URLSearchParams({ q: "url" }), zone.id))
        .total,
      0,
    );
    const sources = await service.list(
      bob,
      new URLSearchParams({ q: "Observed outcomes" }),
      zone.id,
    );
    assert.equal(sources.total, 1);
    assert.equal(sources.items[0].id, card.id);
    assert.equal(
      (
        await service.list(
          bob,
          new URLSearchParams({ q: "Study population" }),
          zone.id,
        )
      ).total,
      1,
    );
  },
);

test(
  "structured evidence search includes visible reading text without JSON keys or editorial metadata",
  options,
  async () => {
    const zone = await createZone();
    const content = {
      question: "设备检出的亚临床房颤，是否应抗凝？",
      answer: "Visible answer marker",
      population: "Eligible participants marker",
      context: "Decision context marker",
      nextStep: "Discuss monitoring marker",
      sections: [{ title: "Section heading marker", text: "Section prose marker", sourceIndexes: [1] }],
      tables: [{
        title: "Table heading marker", columns: ["Study arm marker", "Observation marker"],
        rows: [["Cell treatment marker", "Cell result marker"]], caption: "Table caption marker", sourceIndexes: [1],
      }],
      comparisons: [{
        title: "Comparison heading marker", outcome: "Clinical endpoint marker", timeframe: "Follow-up duration marker",
        denominator: 100, measure: "risk", denominatorUnit: "people",
        control: { label: "Comparator arm marker", events: 7 }, intervention: { label: "Intervention arm marker", events: 4 },
        relativeEffect: "Relative estimate marker", certainty: "Uncertainty statement marker", note: "Chart qualification marker", sourceIndexes: [1],
      }],
    };
    let card = await createCard(zone, alice, { content });
    card = (await service.saveEditorial(alice, {
      expectedRevision: card.revision,
      editorial: { author: { kind: "ai", name: "Metadata author marker", model: "private-test-model" }, status: "review-pending" },
    }, zone.id, card.id)).evidence;
    card = await publish(zone, card);
    await createCard(zone, alice, { content });
    const privateZone = await createZone(alice, false);
    await publish(privateZone, await createCard(privateZone, alice, { content }));
    const visible = [content.question, content.answer, content.population, content.context, content.nextStep,
      content.sections[0].title, content.sections[0].text, content.tables[0].title, ...content.tables[0].columns,
      ...content.tables[0].rows[0], content.tables[0].caption, content.comparisons[0].title,
      content.comparisons[0].outcome, content.comparisons[0].timeframe, content.comparisons[0].control.label,
      content.comparisons[0].intervention.label, content.comparisons[0].relativeEffect,
      content.comparisons[0].certainty, content.comparisons[0].note, "100", "7", "4"];
    for (const q of visible) {
      const result = await service.list(bob, new URLSearchParams({ q: q.toUpperCase() }), zone.id);
      assert.equal(result.total, 1, q);
      assert.deepEqual(result.items.map(item => item.id), [card.id], q);
    }
    for (const q of ["question", "nextStep", "sections", "columns", "sourceIndexes", "relativeEffect",
      "denominatorUnit", "risk", "people", "Metadata author marker", "private-test-model", card.editorial.contentHash]) {
      assert.equal((await service.list(bob, new URLSearchParams({ q }), zone.id)).total, 0, q);
    }
    assert.equal((await service.list(bob, new URLSearchParams({ q: content.question }), "*")).total, 1);
    assert.equal((await service.list(alice, new URLSearchParams({ q: content.question, scope: "owned" }), zone.id)).total, 2);
    await service.act(bob, zone.id, "follow", { expectedRevision: zone.revision });
    assert.equal((await service.list(bob, new URLSearchParams({ q: content.question, scope: "following" }), "*")).total, 1);
    const optional = await publish(zone, await createCard(zone, alice, {
      content: { answer: "Optional reading marker", sections: null, tables: null, comparisons: null },
    }));
    const result = await service.list(bob, new URLSearchParams({ q: "Optional reading marker" }), zone.id);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, optional.id);
  },
);

test(
  "list projections stay small while detail and search retain the complete source material",
  options,
  async () => {
    const zone = await createZone(),
      body =
        "Large preserved evidence. ".repeat(1400) + "Unique fulltext marker";
    const excerpt =
      "Long preserved source. ".repeat(400) + "Unique source marker";
    const card = await publish(
      zone,
      await createCard(zone, alice, {
        body,
        sources: [
          { title: "Large source", url: "https://example.org/large", excerpt },
        ],
      }),
    );
    await service.act(
      bob,
      zone.id,
      "review",
      {
        expectedRevision: card.revision,
        score: 4,
        text: "Current peer review",
      },
      card.id,
    );
    const page = await service.list(
      bob,
      new URLSearchParams({ q: "Unique source marker" }),
      zone.id,
    );
    assert.equal(page.total, 1);
    assert.equal(page.items[0].body, "");
    assert.deepEqual(page.items[0].sources, []);
    assert.deepEqual(page.items[0].reviews, []);
    assert.equal(page.items[0].reviewer, "Bob");
    assert.equal(page.items[0].review.score, 4);
    assert.ok(JSON.stringify(page).length < 3000);
    const detail = (await service.detail(bob, zone.id, card.id)).evidence;
    assert.equal(detail.body, body);
    assert.equal(detail.sources[0].excerpt, excerpt);
    assert.equal(detail.reviews[0].text, "Current peer review");
    assert.equal(
      (
        await service.list(
          bob,
          new URLSearchParams({ q: "Unique fulltext marker" }),
          zone.id,
        )
      ).total,
      1,
    );
  },
);

test(
  "following scope owns its rows, feedback is owner-only, and retries do not duplicate content",
  options,
  async () => {
    const input = { ...zoneInput, requestId: "request-zone-1" };
    const first = (await service.save(alice, input)).zone;
    assert.equal((await service.save(alice, input)).zone.id, first.id);
    await assert.rejects(service.save(alice, { ...input, title: "Changed" }), {
      code: "evidence_request_conflict",
    });
    const zone = (
      await service.save(
        alice,
        { expectedRevision: first.revision, state: "published" },
        first.id,
      )
    ).zone;
    const card = await publish(zone, await createCard(zone));
    await service.act(bob, zone.id, "follow", {
      expectedRevision: zone.revision,
    });
    await service.act(bob, zone.id, "follow", {
      expectedRevision: zone.revision,
    });
    assert.equal(
      (await service.list(bob, new URLSearchParams({ scope: "following" })))
        .total,
      1,
    );
    assert.equal(
      (await service.list(alice, new URLSearchParams({ scope: "following" })))
        .total,
      0,
    );
    assert.equal(
      (
        await service.list(
          bob,
          new URLSearchParams({ scope: "following" }),
          "*",
        )
      ).items[0].id,
      card.id,
    );
    const feedback = {
      expectedRevision: zone.revision,
      feedbackInfo: "Question",
      requestId: "request-feedback-1",
    };
    await service.act(bob, zone.id, "feedback", feedback);
    await service.act(bob, zone.id, "feedback", feedback);
    assert.equal((await service.detail(alice, zone.id)).feedback.length, 1);
    assert.equal((await service.detail(bob, zone.id)).feedback.length, 0);
    await service.act(
      bob,
      zone.id,
      "follow",
      { expectedRevision: zone.revision },
      null,
      true,
    );
    assert.equal(
      (await service.list(bob, new URLSearchParams({ scope: "following" })))
        .total,
      0,
    );
  },
);

test(
  "comments have real authors, peers cannot self-review, and edits invalidate prior reviews and research revisions",
  options,
  async () => {
    const zone = await createZone(),
      card = await publish(zone, await createCard(zone));
    const comment = {
      text: "Consider applicability",
      requestId: "request-comment-1",
    };
    await service.act(bob, zone.id, "comments", comment, card.id);
    const detailed = (
      await service.act(bob, zone.id, "comments", comment, card.id)
    ).evidence;
    assert.equal(detailed.discussion.length, 1);
    assert.equal(detailed.discussion[0].author, "Bob");
    assert.equal(detailed.discussion[0].canDelete, true);
    await service.removeComment(
      alice,
      zone.id,
      card.id,
      detailed.discussion[0].id,
    );
    assert.equal(
      (await service.detail(alice, zone.id, card.id)).evidence.discussion
        .length,
      1,
    );
    await service.removeComment(
      bob,
      zone.id,
      card.id,
      detailed.discussion[0].id,
    );
    assert.equal(
      (await service.detail(alice, zone.id, card.id)).evidence.discussion
        .length,
      0,
    );
    const review = {
      expectedRevision: card.revision,
      score: 4,
      text: "Useful with caveats",
    };
    await assert.rejects(
      service.act(alice, zone.id, "review", review, card.id),
      { code: "evidence_reviewer_required" },
    );
    const reviewed = (
      await service.act(bob, zone.id, "review", review, card.id)
    ).evidence;
    assert.equal(reviewed.reviewer, "Bob");
    assert.equal(reviewed.review.score, 4);
    const changed = (
      await service.save(
        alice,
        { summary: "Updated", expectedRevision: card.revision },
        zone.id,
        card.id,
      )
    ).evidence;
    assert.equal(changed.review, null);
    assert.equal(changed.reviews[0].current, false);
    await assert.rejects(
      service.act(bob, zone.id, "research", {
        expectedRevision: zone.revision,
        evidenceId: card.id,
        evidenceRevision: card.revision,
      }),
      { code: "evidence_revision_conflict" },
    );
    const research = await service.act(bob, zone.id, "research", {
      expectedRevision: zone.revision,
      evidenceId: card.id,
      evidenceRevision: changed.revision,
    });
    assert.match(research.draft, /https:\/\/example.org\/trial/);
    assert.match(research.draft, /The trial describes observed outcomes/);
    const zoneResearch = await service.act(bob, zone.id, "research", {
      expectedRevision: zone.revision,
    });
    assert.match(zoneResearch.draft, /专区共1条已发布证据，本次包含1条/);
    assert.doesNotMatch(
      zoneResearch.draft,
      new RegExp(`${zone.id}|${card.id}|"revision"|"totalPublished"`),
    );
    assert.match(zoneResearch.draft, /The trial describes observed outcomes/);
  },
);

test(
  "frontier associations accept only enabled published items and deleting an account cascades its evidence",
  options,
  async () => {
    const zone = await createZone();
    await insertSource(db, "nejm");
    const item = await insertItem(db, { title: "Origin trial" });
    const card = await createCard(zone, alice, { sourceItemId: item.publicId });
    assert.equal(card.sourceItemId, item.publicId);
    await db.query(
      "UPDATE evimed_frontier.items SET state='withdrawn' WHERE id=$1",
      [item.id],
    );
    await assert.rejects(
      createCard(zone, alice, { sourceItemId: item.publicId }),
      { code: "evidence_not_found" },
    );
    const unpublished = (
      await service.save(
        alice,
        { expectedRevision: card.revision, state: "draft" },
        zone.id,
        card.id,
      )
    ).evidence;
    assert.equal(unpublished.sourceItemId, item.publicId);
    await db.query(
      "INSERT INTO evimed_control.users(id,name,auth_type) VALUES('temp','Temp','development')",
    );
    const temp = await createZone({ id: "temp" });
    await db.query("DELETE FROM evimed_control.users WHERE id='temp'");
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM evimed_frontier.evidence_zones WHERE id=$1",
          [temp.id],
        )
      ).rowCount,
      0,
    );
  },
);

test(
  "research drafts clearly label bounded source quotations and partial zone scope",
  options,
  async () => {
    const zone = await createZone();
    for (let index = 0; index < 12; index++)
      await publish(
        zone,
        await createCard(zone, alice, {
          title: `Bounded card ${index}`,
          body: "Evidence content. ".repeat(1400),
          sources: [
            {
              title: "Long source",
              url: "https://example.org/source",
              excerpt: "Quoted source text. ".repeat(100),
            },
          ],
        }),
      );
    const research = await service.act(bob, zone.id, "research", {
      expectedRevision: zone.revision,
    });
    assert.match(
      research.draft,
      /专区共12条已发布证据，本次包含10条最近更新的证据/,
    );
    assert.match(research.draft, /本次材料不覆盖整个专区/);
    assert.match(research.draft, /本次仅包含部分内容/);
    assert.match(research.draft, /原文摘录：/);
    assert.match(research.draft, /> Quoted source text/);
    assert.ok(research.draft.length < 48000);
  },
);

test(
  "account archives preserve owned evidence, comments, reviews, feedback and follow rows",
  options,
  async () => {
    const zone = await createZone(),
      card = await publish(zone, await createCard(zone));
    await service.act(bob, zone.id, "follow", {
      expectedRevision: zone.revision,
    });
    await service.act(bob, zone.id, "feedback", {
      expectedRevision: zone.revision,
      feedbackInfo: "A feedback note",
    });
    await service.act(bob, zone.id, "comments", { text: "A comment" }, card.id);
    await service.act(
      bob,
      zone.id,
      "review",
      { expectedRevision: card.revision, score: 3, text: "A peer review" },
      card.id,
    );
    const archive = async (user) => {
      const created = (
        await db.query(
          "SELECT created_at::text AS value FROM evimed_control.users WHERE id=$1",
          [user.id],
        )
      ).rows[0].value;
      return withAccountExportSnapshot(
        db,
        { ...user, accountCreatedAt: created },
        {},
        async (snapshot) => JSON.parse(snapshot.data.toString()),
      );
    };
    const owner = await archive(alice),
      reader = await archive(bob);
    assert.equal(owner.evidenceZones[0].id, zone.id);
    assert.equal(owner.evidenceCards[0].id, card.id);
    assert.equal(reader.evidenceZones.length, 0);
    assert.equal(reader.evidenceCards.length, 0);
    assert.equal(reader.evidenceZoneFollows[0].zone_id, zone.id);
    assert.equal(reader.evidenceComments[0].text, "A comment");
    assert.equal(reader.evidenceReviews[0].text, "A peer review");
    assert.equal(reader.evidenceZoneFeedback[0].text, "A feedback note");
  },
);


test("authenticated scientific edits preserve AI authorship and record account revision history", options, async () => {
  const zone = await createZone();
  const author = {kind:"ai",name:"Evidence author AI",model:"synthetic-test"};
  let card = (await service.saveEditorial(alice, {
    ...cardInput, editorial:{author,status:"review-pending"},
  }, zone.id, null, true)).evidence;
  assert.equal(card.editorial.lastEditor, undefined);
  card = await publish(zone,card);
  assert.equal(card.editorial.lastEditor, undefined);
  card = (await service.saveEditorial(alice, {
    expectedRevision:card.revision,
    editorial:{author,status:"ai-reviewed",contentHash:evidenceContentHash(card),reviewer:{kind:"ai",name:"Independent AI",model:"synthetic-test"}},
  },zone.id,card.id)).evidence;
  assert.equal(card.editorial.status,"ai-reviewed");
  assert.equal(card.editorial.lastEditor,undefined);
  await assert.rejects(service.save(alice, {
    expectedRevision:card.revision,body:"New scientific prose",
    editorial:{...card.editorial,lastEditor:{userId:"bob",name:"Forged",editedAt:new Date().toISOString()}},
  },zone.id,card.id),{code:"evidence_invalid"});
  await assert.rejects(service.save(bob, {
    expectedRevision:card.revision,body:"Unauthorized science",
  },zone.id,card.id),{code:"evidence_owner_required"});
  card = (await service.save({...alice,name:"Spoofed physician"}, {
    expectedRevision:card.revision,body:"Authenticated revised scientific prose",
  },zone.id,card.id)).evidence;
  assert.deepEqual(card.editorial.author,author);
  assert.equal(card.editorial.status,"review-pending");
  assert.equal(card.editorial.reviewer,null);
  const editor=card.editorial.lastEditor;
  assert.equal(editor.userId,"alice");
  assert.equal(editor.name,"Alice");
  assert.ok(Number.isFinite(Date.parse(editor.editedAt)));
  const hash=evidenceContentHash(card);
  assert.equal(evidenceContentHash({...card,editorial:{...card.editorial,lastEditor:null}}),hash);
  assert.throws(()=>evidenceEditorialReceipt({...card.editorial,lastEditor:{...editor,editedAt:"invalid"}},card,card.revision),{code:"evidence_invalid"});
  card = (await service.save(alice, {
    expectedRevision:card.revision,body:card.body,state:"draft",
  },zone.id,card.id)).evidence;
  assert.deepEqual(card.editorial.lastEditor,editor);
  card = (await service.saveEditorial(alice, {
    expectedRevision:card.revision,body:"Later AI prose",
    editorial:{author,status:"review-pending",lastEditor:{userId:"bob",name:"Forged",editedAt:new Date().toISOString()}},
  },zone.id,card.id)).evidence;
  assert.deepEqual(card.editorial.lastEditor,editor);
  assert.deepEqual(card.editorial.author,author);
  const history=(await db.query("SELECT snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1 ORDER BY revision DESC LIMIT 1",[card.id])).rows[0];
  assert.deepEqual(history.snapshot.editorial.lastEditor,editor);
});

test("manual cards without AI receipts retain their creator without invented attribution", options, async () => {
  const zone=await createZone();
  let card=await createCard(zone);
  card=(await service.save(alice,{expectedRevision:card.revision,body:"Revised manual content"},zone.id,card.id)).evidence;
  assert.equal(card.creator,"Alice");
  assert.equal(card.editorial,null);
});


const publicationFixture = async (zone, extraSources = []) => {
  const source={...cardInput.sources[0],documentText:"Complete retained trial source with observed outcomes.",coverage:"full-text",checkedAt:"2026-10-01T00:00:00Z",publicationStatus:{kind:"retracted",notices:["Synthetic authoritative retraction notice"]}};
  return (await service.saveEditorial(alice,{
    ...cardInput,state:"published",sources:[...extraSources,source],
    editorial:{author:{kind:"ai",name:"Original evidence AI",model:"synthetic-test"},status:"review-pending",sourceCheckedAt:source.checkedAt},
  },zone.id,null,true)).evidence;
};
for (const field of ["title","excerpt"]) test(`manual ${field} edits keep a publication warning by normalized URL without stale full-text metadata`,options,async()=>{
  const zone=await createZone();let card=await publicationFixture(zone);
  const original=card.sources[0];
  const edited={title:original.title,url:" HTTPS://EXAMPLE.ORG:443/trial ",excerpt:original.excerpt,[field]:field==="title" ? "Edited source title" : "Edited source quote"};
  await assert.rejects(service.save(alice,{expectedRevision:card.revision,sources:[{...edited,publicationStatus:null}]},zone.id,card.id),{code:"evidence_invalid"});
  card=(await service.save(alice,{expectedRevision:card.revision,sources:[edited]},zone.id,card.id)).evidence;
  assert.equal(card.sources[0].url,original.url);
  assert.deepEqual(card.sources[0].publicationStatus,original.publicationStatus);
  assert.equal(card.sources[0].coverage,"excerpt");assert.equal(card.sources[0].checkedAt,undefined);
  assert.equal(card.sources[0].sha256,evidenceHash(edited.excerpt));assert.notEqual(card.sources[0].sha256,original.sha256);
  const stored=(await db.query('SELECT sources FROM evimed_frontier.evidence_cards WHERE id=$1',[card.id])).rows[0].sources[0];
  assert.equal(stored.documentText,undefined);assert.equal(stored.fetchedSha256,undefined);
  assert.equal(card.editorial.status,"review-pending");assert.equal(card.editorial.reviewer,null);assert.equal(card.editorial.reviewRevision,null);
  assert.equal(card.editorial.sourceCheckedAt,null);assert.equal(card.editorial.lastEditor.name,"Alice");assert.equal(card.editorial.author.kind,"ai");
});

test("duplicate URL quotes inherit every known notice conservatively, while removed or replaced URLs and authoritative clears remain possible",options,async()=>{
  const zone=await createZone();
  let card=await publicationFixture(zone,[
    {...cardInput.sources[0],publicationStatus:{kind:"corrected",notices:["Synthetic correction notice"]}},
    {...cardInput.sources[0],excerpt:"Another quote from the same source"},
  ]);
  card=(await service.save(alice,{expectedRevision:card.revision,sources:[{...cardInput.sources[0],excerpt:"Edited duplicate quote"}]},zone.id,card.id)).evidence;
  assert.equal(card.sources[0].publicationStatus.kind,"retracted");
  assert.deepEqual(card.sources[0].publicationStatus.notices,["Synthetic authoritative retraction notice","Synthetic correction notice"]);
  card=(await service.saveEditorial(alice,{expectedRevision:card.revision,sources:[{...card.sources[0],publicationStatus:null}],editorial:{...card.editorial,status:"review-pending"}},zone.id,card.id)).evidence;
  assert.equal(card.sources[0].publicationStatus,undefined);
  card=await publicationFixture(zone);
  card=(await service.save(alice,{expectedRevision:card.revision,sources:[{...cardInput.sources[0],url:"https://example.org/replacement"}]},zone.id,card.id)).evidence;
  assert.equal(card.sources[0].publicationStatus,undefined);
  card=await publicationFixture(zone);
  card=(await service.save(alice,{expectedRevision:card.revision,state:"draft",sources:[]},zone.id,card.id)).evidence;
  assert.deepEqual(card.sources,[]);
});
