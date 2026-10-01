import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { EvidenceEditorial } from "../src/evidenceEditorial.mjs";
import {
  evidenceHash,
  evidenceContentHash,
} from "../src/evidenceCardContent.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
let isolated,
  db,
  service,
  zone,
  card,
  worker,
  document,
  authorCalls,
  reviewCalls;
const user = { id: "editorial-owner" };
const identity = { kind: "ai", name: "Test AI editor", model: "test-model" };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "editorial");
  db = new ControlPlaneDatabase({
    databaseUrl: isolated.url,
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 2000,
  });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query(
    "INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Editorial Owner','development')",
    [user.id],
  );
  service = new EvidenceZoneService({ database: db });
  await service.ready();
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query(
    "TRUNCATE evimed_frontier.evidence_zones,evimed_frontier.items,evimed_frontier.sources CASCADE",
  );
  zone = (
    await service.save(user, { title: "Kidney trials", state: "published" })
  ).zone;
  document =
    "The randomized trial observed benefit. Population was restricted to adults.";
  authorCalls = 0;
  reviewCalls = 0;
  card = (
    await service.saveEditorial(
      user,
      {
        title: "Kidney trial",
        subtype: "academic",
        summary: "Observed benefit",
        body: "The source reports benefit in adults.",
        limitations: "Adult population only.",
        sources: [
          {
            title: "Primary trial",
            url: "https://example.org/trial",
            excerpt: document,
            documentText: document,
            sha256: evidenceHash(document),
            checkedAt: "2026-10-01T00:00:00Z",
            coverage: "abstract",
          },
        ],
        content: {
          question: "What did the trial find?",
          answer: "Benefit in adults.",
          population: "Adults",
        },
        state: "published",
        editorial: {
          author: identity,
          status: "review-pending",
          sourceCheckedAt: "2026-10-01T00:00:00Z",
          findings: [],
        },
      },
      zone.id,
      null,
      true,
    )
  ).evidence;
  const editor = {
    available: true,
    model: "test-model",
    evidenceCard: async () => {
      authorCalls++;
      return {
        title: "Updated kidney trial",
        summary: "New source observations",
        body: "The source describes updated findings.",
        limitations: "Abstract only.",
        content: {
          question: "What did the trial find?",
          answer: "Updated source observations",
          population: "Adults",
        },
      };
    },
    evidenceReview: async () => {
      reviewCalls++;
      return {
        findings: [
          {
            kind: "coverage",
            text: "Only the abstract was assessed.",
            sourceIndex: 1,
          },
        ],
      };
    },
  };
  worker = new EvidenceEditorial({
    database: db,
    service,
    editor,
    readSource: async () => ({
      text: document,
      receipt: { sha256: evidenceHash(document) },
    }),
    budget: async () => ({ state: "ok" }),
  });
  await worker.automation(
    user,
    zone.id,
    {
      enabled: true,
      query: "kidney",
      sourceTypes: ["journal"],
      intervalHours: 24,
      maxCardsPerRun: 2,
      expectedRevision: zone.revision,
    },
    "PUT",
  );
});
const reviewCard = async () => {
  card = (
    await service.saveEditorial(
      user,
      {
        expectedRevision: card.revision,
        editorial: {
          ...card.editorial,
          status: "ai-reviewed",
          reviewer: { ...identity, name: "Independent AI" },
          contentHash: evidenceContentHash(card),
          findings: [],
          reviewedAt: "2026-10-01T01:00:00Z",
        },
      },
      zone.id,
      card.id,
    )
  ).evidence;
};

test(
  "public owners cannot forge AI review receipts or retained source metadata",
  options,
  async () => {
    await assert.rejects(
      service.save(
        user,
        {
          expectedRevision: card.revision,
          editorial: {
            ...card.editorial,
            status: "ai-reviewed",
            reviewer: identity,
            contentHash: evidenceContentHash(card),
          },
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    await assert.rejects(
      service.save(
        user,
        {
          expectedRevision: card.revision,
          sources: [
            {
              title: "Forged",
              url: "https://example.org",
              excerpt: "x",
              sha256: evidenceHash("x"),
              coverage: "full-text",
              documentText: "x",
            },
          ],
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    await assert.rejects(
      service.save(
        user,
        { expectedRevision: card.revision, sources: [null] },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    assert.equal(card.editorial.reviewOperationId, undefined);
  },
);
test(
  "independent AI receipt binds final content and manual edits preserve unchanged retained sources",
  options,
  async () => {
    await reviewCard();
    assert.equal(card.editorial.reviewRevision, card.revision);
    assert.ok(card.editorial.reviewOperationId);
    assert.equal(card.editorial.reviewOrigin, "import");
    await assert.rejects(
      service.saveEditorial(
        user,
        {
          expectedRevision: card.revision,
          editorial: { ...card.editorial, contentHash: evidenceHash("wrong") },
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    const sources = card.sources.map(({ title, url, excerpt }) => ({
      title,
      url,
      excerpt,
    }));
    const edited = (
      await service.save(
        user,
        {
          expectedRevision: card.revision,
          title: "Manual correction",
          sources,
        },
        zone.id,
        card.id,
      )
    ).evidence;
    assert.equal(edited.sources[0].coverage, "abstract");
    assert.equal(edited.sources[0].sha256, evidenceHash(document));
    assert.equal(edited.editorial.status, "review-pending");
    assert.equal(edited.editorial.reviewer, null);
    const row = (
      await db.query(
        "SELECT sources FROM evimed_frontier.evidence_cards WHERE id=$1",
        [card.id],
      )
    ).rows[0];
    assert.equal(row.sources[0].documentText, document);
    assert.equal(edited.sources[0].documentText, undefined);
    assert.equal(edited.revisions.length, 3);
  },
);
test(
  "source hash checks retained text and changed manual sources lose old coverage receipt",
  options,
  async () => {
    await assert.rejects(
      service.saveEditorial(
        user,
        {
          expectedRevision: card.revision,
          sources: [
            {
              title: "Source",
              url: "https://example.org",
              excerpt: "x",
              documentText: "actual",
              sha256: evidenceHash("different"),
            },
          ],
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    const edited = (
      await service.save(
        user,
        {
          expectedRevision: card.revision,
          sources: [
            {
              title: card.sources[0].title,
              url: card.sources[0].url,
              excerpt: "Changed excerpt",
            },
          ],
        },
        zone.id,
        card.id,
      )
    ).evidence;
    assert.equal(edited.sources[0].coverage, "excerpt");
    assert.equal(edited.sources[0].sha256, evidenceHash("Changed excerpt"));
  },
);
test(
  "unchanged sources are checked without authoring or review calls",
  options,
  async () => {
    await reviewCard();
    await worker.tick();
    assert.equal(authorCalls, 0);
    assert.equal(reviewCalls, 0);
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.revision, card.revision);
    assert.equal(worker.counters.unchanged, 1);
    assert.equal((await worker.automation(user, zone.id)).jobs.completed, 1);
  },
);
test(
  "changed source updates the same card and records independent review and revision history",
  options,
  async () => {
    await reviewCard();
    await service.act(user, zone.id, "feedback", {
      expectedRevision: zone.revision,
      feedbackInfo: "Please clarify kidney population coverage.",
    });
    await service.act(
      user,
      zone.id,
      "comments",
      { text: "What about older adults?" },
      card.id,
    );
    let writerContext;
    const write = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      writerContext = input;
      return write(input);
    };
    document += " Newly reported outcome.";
    await worker.tick();
    assert.ok(
      writerContext.readerQuestions.some(
        (question) => question.origin === "zone-question",
      ),
    );
    assert.ok(
      writerContext.readerQuestions.some(
        (question) => question.origin === "card-comment",
      ),
    );
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 1);
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.id, card.id);
    assert.equal(current.editorial.status, "ai-reviewed");
    assert.equal(current.editorial.reviewRevision, current.revision);
    assert.equal(current.editorial.reviewOrigin, "model");
    assert.equal(current.editorial.findings[0].kind, "coverage");
    assert.equal(current.revisions.length, 4);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM evimed_frontier.evidence_cards",
          )
        ).rows[0].n,
      ),
      1,
    );
  },
);
test(
  "review outage preserves produced card and retry reviews without reauthoring unchanged sources",
  options,
  async () => {
    await reviewCard();
    document += " Changed outcome.";
    worker.editor.evidenceReview = async () => {
      reviewCalls++;
      throw Object.assign(new Error("offline"), {
        code: "evidence_review_offline",
      });
    };
    await worker.tick();
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 1);
    let current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.editorial.status, "review-pending");
    assert.equal(current.state, "published");
    await db.query(
      "UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()",
    );
    worker.editor.evidenceReview = async () => {
      reviewCalls++;
      return { findings: [] };
    };
    await worker.tick();
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 2);
    current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.editorial.status, "ai-reviewed");
  },
);
test(
  "manual edit stops automatic overwrites and leased internal writes require current ownership",
  options,
  async () => {
    await reviewCard();
    await worker.tick();
    card = (await service.detail(user, zone.id, card.id)).evidence;
    await service.save(
      user,
      { expectedRevision: card.revision, body: "Researcher correction" },
      zone.id,
      card.id,
    );
    await worker.automation(user, zone.id, {}, "POST");
    await worker.tick();
    const status = await worker.automation(user, zone.id);
    assert.equal(status.jobs.conflict, 1);
    assert.equal(authorCalls, 0);
    await assert.rejects(
      service.saveEditorial(
        user,
        { expectedRevision: card.revision, title: "Stale lease writer" },
        zone.id,
        card.id,
        false,
        "model",
        { jobId: status.recent[0].id, workerId: "not-the-owner" },
      ),
      { code: "evidence_lease_lost" },
    );
  },
);

test(
  "discovery is not starved by a full existing-card batch and new sources update the same clinical question",
  options,
  async () => {
    await reviewCard();
    for (let index = 0; index < 3; index++)
      await service.saveEditorial(
        user,
        {
          title: `Existing card ${index}`,
          subtype: "academic",
          summary: "Existing",
          body: "Existing source-based card",
          limitations: "Abstract only",
          state: "published",
          sources: [
            {
              title: "Existing",
              url: `https://example.org/old-${index}`,
              excerpt: document,
              documentText: document,
              coverage: "abstract",
            },
          ],
          editorial: {
            author: identity,
            status: "review-pending",
            findings: [],
          },
        },
        zone.id,
        null,
        true,
      );
    await insertSource(db, "trial-journal");
    await insertItem(db, {
      sourceId: "trial-journal",
      title: "A new kidney trial",
    });
    let mappedInput;
    const write = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      if (input.previous?.title === card.title) mappedInput = input;
      return write(input);
    };
    let targetCalls = 0;
    worker.editor.evidenceTarget = async (input) => {
      targetCalls++;
      assert.ok(input.cards.some((c) => c.id === card.id));
      return card.id;
    };
    await worker.tick();
    await worker.tick();
    const jobs = (
      await db.query(
        "SELECT source_item_id,card_id FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
        [zone.id],
      )
    ).rows;
    const candidate = jobs.find((j) => j.source_item_id);
    assert.ok(
      candidate,
      "New primary source must be queued even when existing cards exceed the batch size",
    );
    assert.equal(candidate.card_id, card.id);
    assert.ok(
      (
        await db.query(
          "SELECT state FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
          [zone.id],
        )
      ).rows.every((job) => job.state === "completed"),
      "An automatic revision must advance sibling pending jobs rather than masquerading as a researcher edit",
    );
    assert.equal(targetCalls, 1);
    assert.equal(mappedInput.sources[0].url, card.sources[0].url);
    assert.equal(mappedInput.sources[0].sourceIndex, 1);
    assert.equal(mappedInput.sources.length, 2);
    assert.equal(mappedInput.previous.sources[0].sourceIndex, 1);
    assert.equal(mappedInput.previous.sources[0].url, card.sources[0].url);
    const updated = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(updated.sources[0].url, card.sources[0].url);
    assert.notEqual(updated.sources[1].url, card.sources[0].url);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM evimed_frontier.evidence_cards",
          )
        ).rows[0].n,
      ),
      4,
    );
  },
);
test(
  "budget exhaustion permits free source checks and leaves changed content waiting without author calls",
  options,
  async () => {
    await reviewCard();
    worker.budget = async () => ({ state: "exhausted" });
    await worker.tick();
    assert.equal(worker.counters.unchanged, 1);
    assert.equal(authorCalls, 0);
    document += " Source changed.";
    await worker.automation(user, zone.id, {}, "POST");
    await worker.tick();
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.ok(current.editorial.sourceChangedAt);
    assert.equal(current.revision, card.revision);
    assert.equal(current.editorial.status, "review-pending");
    assert.equal(current.editorial.reviewer, null);
    assert.equal(authorCalls, 0);
    const status = await worker.automation(user, zone.id);
    assert.equal(status.jobs.pending, 1);
    assert.equal(status.recent[0].attempts, 0);
    assert.equal(status.recent[0].lastError, "evidence_budget_wait");
  },
);

test(
  "an expired worker cannot overwrite the new lease owner's durable status",
  options,
  async () => {
    await reviewCard();
    await worker.schedule();
    const first = await worker.claim();
    await db.query(
      "UPDATE evimed_frontier.evidence_editorial_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const replacement = new EvidenceEditorial({
      database: db,
      service,
      editor: worker.editor,
      readSource: worker.readSource,
      workerId: "replacement-worker",
    });
    const second = await replacement.claim();
    assert.equal(second.id, first.id);
    await replacement.finish(second, "completed");
    await worker.finish(first, "failed", "evidence_stale_worker");
    const status = await worker.automation(user, zone.id);
    assert.equal(status.automation.lastError, null);
    assert.equal(status.recent[0].state, "completed");
    assert.equal(status.recent[0].lastError, null);
  },
);
test(
  "a manual revision racing an unchanged source check is a conflict, not a successful update",
  options,
  async () => {
    await reviewCard();
    let changed = false;
    worker.readSource = async () => {
      if (!changed) {
        changed = true;
        await service.save(
          user,
          {
            expectedRevision: card.revision,
            title: "Concurrent researcher edit",
          },
          zone.id,
          card.id,
        );
      }
      return { text: document, receipt: { sha256: evidenceHash(document) } };
    };
    await worker.tick();
    const status = await worker.automation(user, zone.id);
    assert.equal(status.jobs.conflict, 1);
    assert.equal(worker.counters.unchanged, 0);
    assert.equal(authorCalls, 0);
    assert.equal(
      (await service.detail(user, zone.id, card.id)).evidence.title,
      "Concurrent researcher edit",
    );
  },
);

test(
  "withdrawal after first scheduling cannot be undone by a changed-source editorial task",
  options,
  async () => {
    await reviewCard();
    await worker.schedule();
    const scheduled = (
      await db.query(
        "SELECT payload FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
        [zone.id],
      )
    ).rows[0];
    assert.equal(scheduled.payload.managedRevision, card.revision);
    await service.save(
      user,
      { expectedRevision: card.revision, state: "draft" },
      zone.id,
      card.id,
    );
    document += " Changed source after scheduling.";
    await worker.tick();
    assert.equal(
      (await service.detail(user, zone.id, card.id)).evidence.state,
      "draft",
    );
    assert.equal(authorCalls, 0);
    assert.equal(reviewCalls, 0);
    assert.equal((await worker.automation(user, zone.id)).jobs.conflict, 1);
  },
);
test(
  "a zone withdrawn during authoring is rejected inside the save transaction",
  options,
  async () => {
    await reviewCard();
    document += " Changed source.";
    const originalWrite = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      const output = await originalWrite(input);
      await service.save(
        user,
        { expectedRevision: zone.revision, state: "draft" },
        zone.id,
      );
      return output;
    };
    await worker.tick();
    assert.equal((await service.detail(user, zone.id)).zone.state, "draft");
    assert.equal(
      (await service.detail(user, zone.id, card.id)).evidence.title,
      card.title,
    );
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 0);
    assert.equal((await worker.automation(user, zone.id)).jobs.conflict, 1);
  },
);
test(
  "a card withdrawn during authoring is rejected by the saved revision and publication guard",
  options,
  async () => {
    await reviewCard();
    document += " Changed source.";
    const originalWrite = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      const output = await originalWrite(input);
      await service.save(
        user,
        { expectedRevision: card.revision, state: "draft" },
        zone.id,
        card.id,
      );
      return output;
    };
    await worker.tick();
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.state, "draft");
    assert.equal(current.title, card.title);
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 0);
    assert.equal((await worker.automation(user, zone.id)).jobs.conflict, 1);
  },
);
