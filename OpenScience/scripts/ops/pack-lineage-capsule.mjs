#!/usr/bin/env node
/**
 * Pack one TCM CDSS lineage card (流派卡) as a `.evimedcap` memory capsule.
 *
 *   node scripts/ops/pack-lineage-capsule.mjs --card <card.json> --identity <identity.json> \
 *     --password-file <file> [--out <dir>] [--version <n>] [--new-identity] [--allow-unreviewed]
 *
 * The 甲方 plan's week one is 「经方、温病、丹溪滋阴、温补、扶阳五个流派思路按胶囊格式封装」,
 * and nothing produced a capsule from a card. This does, from the card as the
 * CDSS defines it (`src/lib/tcm-lineages.ts`: `LineageCard`, optionally with its
 * `LineageQuestionStrategy`). The input file is either the card itself or
 * `{ "card": …, "questionStrategy": … }`.
 *
 * What the pack holds:
 *
 *  - one method per stage the card speaks to — M02 追问 (from the question
 *    strategy, when there is one), M03 辨病辨证, M04 候选方药与加减 — each a
 *    `method_preference` entry at `methods/<id>/SKILL.md`, its text naming the
 *    stage it is for;
 *  - `standards.jsonl`: the card's safety deference and its cautions;
 *  - `profile.md`: the card itself — lineage, physicians, works, aliases and its
 *    governance (version, status, author, reviewers, dates);
 *  - the pack's card in the signed manifest: the lineage's name as its title,
 *    the governance group as its author, its core theory as the summary.
 *
 * Why `methods/<id>` and not `methods/<stage>`: the importer
 * (`CapsuleTransferService.inspect`) accepts exactly the layout the platform's
 * own export writes — each method under its entry's id — and compares every
 * file byte for byte with what it would have rendered. So this script renders
 * with the importer's own two functions (`renderCapsuleTransferFiles`,
 * `capsuleTransferLocation`) rather than a copy of them, and the ids are
 * derived from card, version and stage, so the same card packs to the same ids
 * every time. A pack laid out any other way would be refused by every
 * deployment that has to open it.
 *
 * Signed and encrypted exactly as an export is: `packCapsule` (Ed25519 over the
 * canonical manifest, AES-256-GCM per entry, the pack key wrapped by scrypt
 * from the password). The signing identity is a file of its own — the content
 * governance group's, not an account's — made once with `--new-identity`
 * (0600, never overwritten). An importing deployment that does not know the
 * key shows the pack as 「发布者未验证」, which is true until key distribution
 * exists (build spec §9, P4).
 *
 * What it refuses, before anything is written: a card that carries a dose (a
 * number with a unit — 「胶囊不携带剂量」, build spec C5), text a method may not
 * carry (credentials, patient identifiers), a retired card, and a card not yet
 * reviewed unless `--allow-unreviewed` says it is a draft for review.
 *
 * The password is read from a file, never from the command line, where every
 * process on the host can read it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { hasSensitiveText } from "@evimed/domain";

import { generateCapsuleIdentity, packCapsule } from "../../apps/server/src/capsuleContainer.mjs";
import {
  CAPSULE_TRANSFER_MAX_BYTES,
  capsuleCard,
  capsuleTransferLocation,
  renderCapsuleTransferFiles,
} from "../../apps/server/src/capsuleTransferService.mjs";

/** The stages a lineage card reaches in the CDSS pipeline. */
export const LINEAGE_STAGES = Object.freeze([
  { code: "M02", name: "追问" },
  { code: "M03", name: "辨病辨证" },
  { code: "M04", name: "候选方药与加减" },
]);

/** A number with a dose unit. A format check over the card's own fields, not
 *  a reading of its prose: a card that states an amount is refused whole. */
const DOSE_PATTERN = /\d+(?:\.\d+)?\s*(?:g|mg|kg|ml|克|毫克|千克|钱|两|分|毫升|升|丸|粒|片)(?![a-z])/i;

const STATUS_LABELS = Object.freeze({ draft: "草稿", in_review: "审核中", active: "生效", retired: "退役" });
const GROUP_LABELS = Object.freeze({ default: "默认", classic: "经典辨治", school: "学术流派" });

/** @param {string} message @param {string} code */
function refusal(message, code) {
  return Object.assign(new Error(message), { code });
}

/** @param {unknown} value @param {string} field */
function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw refusal(`${field} must be a non-empty string.`, "lineage_card_invalid");
  return value.trim();
}

/** @param {unknown} value @param {string} field @param {{ allowEmpty?: boolean }} [options] */
function texts(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw refusal(`${field} must be a list of strings.`, "lineage_card_invalid");
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

/**
 * The card and its question strategy, checked field by field.
 * @param {any} input
 */
export function readLineageCard(input) {
  const raw = input && typeof input === "object" && "card" in input ? input.card : input;
  const strategy = input && typeof input === "object" && "card" in input ? input.questionStrategy ?? null : null;
  if (!raw || typeof raw !== "object") throw refusal("The file holds no lineage card.", "lineage_card_invalid");
  const code = text(raw.code, "code");
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(code)) throw refusal("code must be a lower-case identifier.", "lineage_card_invalid");
  const governance = raw.governance ?? {};
  const card = {
    code,
    label: text(raw.label, "label"),
    group: text(raw.group, "group"),
    cardNature: text(raw.cardNature, "cardNature"),
    aliases: texts(raw.aliases ?? [], "aliases").filter(Boolean),
    provenance: {
      representativePhysicians: texts(raw.provenance?.representativePhysicians ?? [], "provenance.representativePhysicians"),
      representativeWorks: texts(raw.provenance?.representativeWorks ?? [], "provenance.representativeWorks"),
      lineageSummary: text(raw.provenance?.lineageSummary, "provenance.lineageSummary"),
    },
    governance: {
      schemaVersion: text(governance.schemaVersion, "governance.schemaVersion"),
      cardVersion: text(governance.cardVersion, "governance.cardVersion"),
      status: text(governance.status, "governance.status"),
      author: text(governance.author?.displayName, "governance.author.displayName"),
      reviewedBy: (Array.isArray(governance.reviewedBy) ? governance.reviewedBy : [])
        .map((/** @type {any} */ reviewer, /** @type {number} */ index) => text(reviewer?.displayName, `governance.reviewedBy[${index}].displayName`)),
      reviewedAt: text(governance.reviewedAt, "governance.reviewedAt"),
      effectiveAt: text(governance.effectiveAt, "governance.effectiveAt"),
    },
    safetyObedience: text(raw.safetyObedience, "safetyObedience"),
    coreTheory: text(raw.coreTheory, "coreTheory"),
    dxEmphasis: texts(raw.dxEmphasis, "dxEmphasis", { allowEmpty: false }),
    formulaStyle: text(raw.formulaStyle, "formulaStyle"),
    representativeFormulas: texts(raw.representativeFormulas ?? [], "representativeFormulas"),
    herbTendency: text(raw.herbTendency, "herbTendency"),
    modificationStyle: text(raw.modificationStyle, "modificationStyle"),
    applicability: text(raw.applicability, "applicability"),
    cautions: texts(raw.cautions ?? [], "cautions"),
  };
  if (!Object.hasOwn(STATUS_LABELS, card.governance.status)) {
    throw refusal(`governance.status must be one of ${Object.keys(STATUS_LABELS).join(", ")}.`, "lineage_card_invalid");
  }
  let questionStrategy = null;
  if (strategy != null) {
    if (text(strategy.lineageCode, "questionStrategy.lineageCode") !== code) {
      throw refusal("questionStrategy.lineageCode must name the same card.", "lineage_card_invalid");
    }
    questionStrategy = {
      inquiryFocus: texts(strategy.inquiryFocus ?? [], "questionStrategy.inquiryFocus"),
      syndromeAnchors: texts(strategy.syndromeAnchors ?? [], "questionStrategy.syndromeAnchors"),
      contraindicationBoundaries: texts(strategy.contraindicationBoundaries ?? [], "questionStrategy.contraindicationBoundaries"),
      questions: (Array.isArray(strategy.templates) ? strategy.templates : []).map((/** @type {any} */ template, /** @type {number} */ index) => ({
        question: text(template?.question, `questionStrategy.templates[${index}].question`),
        reason: text(template?.reason, `questionStrategy.templates[${index}].reason`),
      })),
    };
  }
  return { card, questionStrategy };
}

/**
 * Every string of the card, with where it is — what the refusals name.
 * @param {unknown} value @param {string} [at] @returns {{ at: string, value: string }[]}
 */
function strings(value, at = "card") {
  if (typeof value === "string") return [{ at, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${at}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => strings(item, `${at}.${key}`));
  return [];
}

/** @param {string} seed a UUID-shaped id derived from a seed, the same every time */
function derivedId(seed) {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The texts of the pack: one method per stage, the standards, the card.
 * @param {ReturnType<typeof readLineageCard>} lineage
 */
export function lineageEntries({ card, questionStrategy }) {
  const source = `来源：流派卡 ${card.code}，卡片版本 ${card.governance.cardVersion}（${STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (card.governance.status)]}）。`;
  const lines = (/** @type {(string | false)[]} */ ...parts) => parts.filter((part) => typeof part === "string" && part).join("\n");
  /** @type {{ stage: string, content: string }[]} */
  const methods = [];
  if (questionStrategy) {
    methods.push({ stage: "M02", content: lines(
      `# ${card.label} · 追问（M02）`, "", source, "",
      questionStrategy.inquiryFocus.length > 0 && `追问焦点：${questionStrategy.inquiryFocus.join("、")}`,
      questionStrategy.syndromeAnchors.length > 0 && `证候锚点：${questionStrategy.syndromeAnchors.join("、")}`,
      questionStrategy.contraindicationBoundaries.length > 0 && `禁忌与边界：${questionStrategy.contraindicationBoundaries.join("、")}`,
      questionStrategy.questions.length > 0 && "可选问题：",
      ...questionStrategy.questions.map((item) => `- ${item.question}（${item.reason}）`),
      "", card.safetyObedience,
    ) });
  }
  methods.push({ stage: "M03", content: lines(
    `# ${card.label} · 辨病辨证（M03）`, "", source, "",
    `核心理论：${card.coreTheory}`,
    `辨证重点：${card.dxEmphasis.join("、")}`,
    `源流：${card.provenance.lineageSummary}`,
    `适用边界：${card.applicability}`,
    "", card.safetyObedience,
  ) });
  methods.push({ stage: "M04", content: lines(
    `# ${card.label} · 候选方药与加减（M04）`, "", source, "",
    `组方风格：${card.formulaStyle}`,
    card.representativeFormulas.length > 0 && `代表方示例：${card.representativeFormulas.join("、")}`,
    `药物倾向：${card.herbTendency}`,
    `加减风格：${card.modificationStyle}`,
    card.cautions.length > 0 && `注意：${card.cautions.join("；")}`,
    "", card.safetyObedience,
  ) });
  const standards = [card.safetyObedience, ...card.cautions];
  const profile = lines(
    `流派卡：${card.label}（${card.code}）`,
    `分组：${GROUP_LABELS[/** @type {keyof typeof GROUP_LABELS} */ (card.group)] ?? card.group}；性质：${card.cardNature}`,
    card.provenance.representativePhysicians.length > 0 && `代表医家：${card.provenance.representativePhysicians.join("、")}`,
    card.provenance.representativeWorks.length > 0 && `代表著作：${card.provenance.representativeWorks.join("、")}`,
    card.aliases.length > 0 && `别名：${card.aliases.join("、")}`,
    `治理：结构版本 ${card.governance.schemaVersion}；卡片版本 ${card.governance.cardVersion}；状态 ${STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (card.governance.status)]}；`
      + `作者 ${card.governance.author}；审核 ${card.governance.reviewedBy.join("、") || "无"}；审核日期 ${card.governance.reviewedAt}；生效日期 ${card.governance.effectiveAt}`,
  );
  return { methods, standards, profile };
}

/**
 * Pack a card. Returns the archive text an import accepts, and what is in it.
 *
 * @param {any} input the card, or `{ card, questionStrategy }`
 * @param {{ identity: { issuerId: string, signing: { keyId: string, publicKey: string, privateKey: string } }, password: string,
 *   packVersion?: number, allowUnreviewed?: boolean, now?: () => Date }} options
 * @returns {Promise<{ archive: string, filename: string, snapshotId: string, stages: string[], entries: number, archiveSha256: string }>}
 */
export async function packLineageCard(input, { identity, password, packVersion = 1, allowUnreviewed = false, now = () => new Date() }) {
  const lineage = readLineageCard(input);
  const { card } = lineage;
  if (card.governance.status === "retired") throw refusal("A retired card is not packed.", "lineage_card_retired");
  if (card.governance.status !== "active" && !allowUnreviewed) {
    throw refusal(`The card is ${card.governance.status}, not reviewed; pass --allow-unreviewed to pack a draft for review.`, "lineage_card_unreviewed");
  }
  const every = strings({ ...card, questionStrategy: lineage.questionStrategy });
  const doses = every.filter((item) => DOSE_PATTERN.test(item.value));
  if (doses.length) {
    throw refusal(`A capsule carries no dose; these fields state one: ${doses.map((item) => item.at).join(", ")}.`, "lineage_card_dose");
  }
  const sensitive = every.filter((item) => hasSensitiveText(item.value));
  if (sensitive.length) {
    throw refusal(`These fields carry credentials or identifiers: ${sensitive.map((item) => item.at).join(", ")}.`, "lineage_card_sensitive");
  }
  if (!Number.isSafeInteger(packVersion) || packVersion < 1) throw refusal("The pack version must be a positive integer.", "lineage_card_invalid");
  if (typeof password !== "string" || !password) throw refusal("A pack is encrypted; a password is required.", "lineage_card_password");

  const { methods, standards, profile } = lineageEntries(lineage);
  const seed = `lineage:${card.code}:${card.governance.cardVersion}:${packVersion}`;
  const snapshotId = derivedId(`${seed}:pack`);
  /** @param {string} key @param {string} factKind @param {string} content */
  const entry = (key, factKind, content) => {
    const id = derivedId(`${seed}:${key}`);
    const place = capsuleTransferLocation(factKind);
    // An export's entry, field for field (`CapsuleTransferService.export`):
    // the content-governance group wrote it, so it is explicit.
    return { id, version: packVersion, factKind, layer: place.layer, content, sha256: sha256(content),
      path: place.path ?? `methods/${id}/SKILL.md`, origin: "explicit" };
  };
  const entries = [
    ...methods.map((method) => entry(`method:${method.stage}`, "method_preference", method.content)),
    ...standards.map((standard, index) => entry(`standard:${index}`, "preference", standard)),
    entry("card", "expertise", profile),
  ];
  const files = renderCapsuleTransferFiles(snapshotId, entries);
  const container = await packCapsule({
    capsuleId: snapshotId,
    version: packVersion,
    createdAt: now().toISOString(),
    issuer: { userId: identity.issuerId, signingKeyId: identity.signing.keyId, signingPrivateKey: identity.signing.privateKey },
    scope: ["workstyle", "+profile"],
    layers: [...new Set([...entries.map((item) => item.layer), "methods"])],
    attribution: `${card.governance.author}：${card.label}（卡片 ${card.governance.cardVersion}）`,
    // The pack's card, in the signed manifest: what a recipient reads before
    // any entry, and the title an import takes (`capsuleCard`).
    card: capsuleCard({
      title: card.label,
      author: card.governance.author,
      summary: [...card.coreTheory].slice(0, 500).join(""),
      changelog: `卡片版本 ${card.governance.cardVersion}，${STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (card.governance.status)]}，生效日期 ${card.governance.effectiveAt}`,
    }),
    password,
    entries: Object.entries(files).map(([file, content]) => ({
      path: file,
      content,
      mime: file.endsWith(".json") ? "application/json" : file.endsWith(".jsonl") ? "application/x-ndjson" : "text/markdown",
      layer: file === "provenance.json" ? "methods" : /** @type {any} */ (entries.find((item) => item.path === file)).layer,
    })),
  });
  const archive = JSON.stringify({
    format: "evimedcap", version: 1, manifest: container.manifest, issuerPublicKey: identity.signing.publicKey,
    passwordWrap: /** @type {Buffer} */ (container.passwordWrap).toString("base64"),
    payload: Object.fromEntries(Object.entries(container.payload).map(([file, bytes]) => [file, bytes.toString("base64")])),
  });
  if (Buffer.byteLength(archive) > CAPSULE_TRANSFER_MAX_BYTES) throw refusal("The pack exceeds the 2 MiB a transfer carries.", "lineage_card_too_large");
  return {
    archive,
    filename: `${card.code}-v${packVersion}.evimedcap`,
    snapshotId,
    stages: methods.map((method) => method.stage),
    entries: entries.length,
    archiveSha256: sha256(archive),
  };
}

/** A signing identity for content governance, made once. */
export function newPackIdentity() {
  const identity = generateCapsuleIdentity();
  return { issuerId: `lineage-${identity.signing.keyId}`, signing: identity.signing };
}

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = {};
  const valued = new Set(["--card", "--identity", "--password-file", "--out", "--version"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--new-identity" || argument === "--allow-unreviewed") options[argument] = true;
    else if (valued.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      options[argument] = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  for (const required of ["--card", "--identity", "--password-file"]) {
    if (!options[required]) throw new Error(`${required} is required`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const identityPath = path.resolve(String(options["--identity"]));
  if (options["--new-identity"]) {
    // Never overwritten: a second key under the same name would orphan every
    // pack the first one signed.
    await fs.writeFile(identityPath, `${JSON.stringify(newPackIdentity(), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`wrote a new signing identity to ${identityPath}\n`);
  }
  const identity = JSON.parse(await fs.readFile(identityPath, "utf8"));
  const password = (await fs.readFile(path.resolve(String(options["--password-file"])), "utf8")).replace(/\r?\n$/, "");
  const card = JSON.parse(await fs.readFile(path.resolve(String(options["--card"])), "utf8"));
  const packed = await packLineageCard(card, {
    identity,
    password,
    packVersion: options["--version"] ? Number(options["--version"]) : 1,
    allowUnreviewed: options["--allow-unreviewed"] === true,
  });
  const outDir = path.resolve(String(options["--out"] ?? "."));
  await fs.mkdir(outDir, { recursive: true });
  const target = path.join(outDir, packed.filename);
  await fs.writeFile(target, packed.archive, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ file: target, snapshotId: packed.snapshotId, stages: packed.stages, entries: packed.entries, sha256: packed.archiveSha256 })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`pack-lineage-capsule: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}

