/**
 * The `manuscript-section` contract: one section of a manuscript, graded on the
 * bindings a reader cannot reconstruct for themselves.
 *
 * Hidden knowledge: why a writing capability is checked at all, given that
 * nothing here can tell whether the argument is any good. It cannot, and it
 * does not try — register, rhythm, whether the discussion earns its conclusion
 * and whether the section is the right length are the model's judgement and
 * live in `capabilities/manuscript-support/SKILL.md`. What code owns is the
 * half that survives rewriting: a section is edited three or four times, by
 * different passes with different context, and each pass is an opportunity for
 * a sentence to drift off the source it was bonded to. `[7]` still has to name
 * a row in the ledger; `<!-- claim:CLM-004 -->` still has to name a claim; a
 * derived result still has to read as derived. Those are decidable, they are
 * exactly what a reader cannot check for themselves, and they are what this
 * file is.
 *
 * The one rule here that is about genre rather than binding — a revision note
 * left standing in the section — is decided by verbatim identity with
 * `revision-notes.md`, never by recognizing what a revision note sounds like.
 * Recognizing the genre is language judgement (principle #5); finding the same
 * paragraph in two files is not.
 *
 * Everything this file raises on its own is `advisory`. The blocking budget is
 * six system-wide and it is spent, and this capability has produced no real
 * runs yet — the metrics beside the findings are how the distribution that
 * would justify promoting one gets collected. The two blocking rules it does
 * apply, the manifest's required-output check and the shared prose hygiene, are
 * the ones every report-shaped kind already had; keeping them is preservation,
 * not a seventh blocking point.
 */

// Nothing from `clinicalEvidence.mjs`, `contractKinds.mjs` or `safetyRules.mjs`
// is imported here any more, and that is the point: the citation-integrity,
// runtime-leakage and clinical-content rules this module used to re-apply are
// applied once, by the shared validator this one composes with.
import { workspaceLayout } from './workspaceLayout.mjs'

/** @typedef {import('./contractRegistry.mjs').GateIssue} GateIssue */
/** @typedef {import('./contractRegistry.mjs').GateVerdict} GateVerdict */
/** @typedef {import('./contractRegistry.mjs').GateInput} GateInput */

/** The section itself. One section per deliverable; see the capability manifest. */
const SECTION_FILE = 'manuscript-section.md'
/** The claim ledger, in the evidence matrix's own claim shape. */
const CLAIMS_FILE = 'section-claims.json'
/** The citation ledger every capability in this platform writes. */
const LEDGER_FILE = 'citation-ledger.csv'

/**
 * The working copy SKILL.md tells the run to take before editing in place.
 *
 * Named here, and exported, because it is a closed known filename and that is
 * the class of thing this repository decides in code. Left to the prompt it
 * behaved as both halves of the same defect: the prose scan graded the snapshot
 * as report prose — so a scratch file could block a package at `required`
 * severity for leakage the delivered section did not contain — and nothing
 * noticed when the run forgot to delete it and shipped a duplicate section.
 */
export const MANUSCRIPT_SCRATCH_FILE = 'manuscript-section.pre-edit.md'

/**
 * How a derived result is marked in prose so a reader can never take it for a
 * measurement.
 *
 * The same closed set `clinicalEvidence.mjs` requires in a clinical report and
 * `manuscript-humanize` protects byte-identically through the humanize pass.
 * Kept in step by hand because that module does not export it — the alternative
 * was a second, subtly different mark, which is worse than a copy: the run
 * would satisfy one checker and fail the other with the same document. A closed
 * set does not have to grow to stay correct, which is why freezing it costs
 * nothing (`packages/domain/test/vocabulary.test.mjs` says so about the
 * original).
 */
const DERIVED_MARK_PATTERN = /[〔［【(（[]\s*(?:推导|推算|估算|derived|estimated)\s*[〕］】)）\]]/i

/** Claim markers, visible and hidden, as `clinicalEvidence.mjs` defines them. */
const VISIBLE_CLAIM_MARKER = /\[claim:(CLM-[0-9]{3,6})\]/g
const HIDDEN_CLAIM_MARKER = /<!--\s*claim:(CLM-[0-9]{3,6})\s*-->/g

/**
 * A numbered citation: `[7]`, `[3,4]`, `[3，4]`, `[3、4]`. A format check over a
 * closed shape, which is what separates it from a pattern about prose.
 *
 * **Deliberately the same grammar as `citationIntegrityIssues`, separators
 * included.** This validator composes that check at `required` severity over
 * the same file, so whichever grammar it recognises is the one that decides
 * whether a package ships. An earlier version here also accepted ranges
 * (`[3-5]`) and expanded them, which made this module the more generous of the
 * two: a section written with `[1-2]` read as clean here and was then blocked
 * by the shared check reporting references 1 and 2 as listed but never cited.
 * A second, laxer parser beside a blocking one does not add tolerance — it
 * teaches runs to write citations the gate rejects.
 *
 * Ranges are a real convention, and supporting them is a change to the shared
 * rule, argued once, for every contract that composes it. Until then SKILL.md
 * tells the run to write `[1,2]`, which is a prior in context rather than a
 * divergence in code.
 *
 * Three digits at most, which also keeps `[2019]`-style years from being read
 * as reference numbers.
 */
const CITATION_MARKER = /\[(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\]/g

/**
 * Shortest paragraph of `revision-notes.md` that means anything when it also
 * appears in the section.
 *
 * Below this, identity is coincidence: a heading, a date, a file name, a
 * section name and a subheading all legitimately appear in both files, and none
 * of them reaches forty characters once whitespace is folded away.
 *
 * The unit is characters rather than words because the baseline language is
 * Chinese and the two scales are not comparable — a forty-character Chinese
 * paragraph is two clauses, a forty-character English one is seven words. Set
 * at sixty first, which read as safe and silently missed the real case it was
 * written for: a fifty-one-character revision note pasted whole into the
 * section.
 */
const BACKSTAGE_PARAGRAPH_FLOOR = 40

/**
 * @param {string} code @param {string} message
 * @param {{severity?: 'required'|'advisory'|'optional', line?: number, path?: string, check?: string | null}} [extra]
 * @returns {GateIssue}
 */
function issue(code, message, extra = {}) {
  return { code, message, severity: extra.severity ?? 'required', ...(extra.line ? { line: extra.line } : {}), ...(extra.path ? { path: extra.path } : {}), ...(extra.check ? { check: extra.check } : {}) }
}

/** @param {GateInput} input @param {string} path @returns {string} */
function text(input, path) {
  return input.files.get(path) ?? ''
}


/**
 * CSV records, quote-aware, because a `supportQuote` column contains commas and
 * splitting on them turns a correct ledger into an unreadable one. A copy of
 * the reader in `clinicalEvidence.mjs`, which does not export it.
 * @param {string} value @returns {string[][]}
 */
function csvRecords(value) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n')
  /** @type {string[][]} */
  const records = []
  /** @type {string[]} */
  let record = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (source[index + 1] === '"') { field += '"'; index += 1 }
      else quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') { record.push(field); field = '' }
    else if (char === '\n') { record.push(field); records.push(record); record = []; field = '' }
    else field += char
  }
  if (field || record.length) { record.push(field); records.push(record) }
  return records.filter((row) => row.some((cell) => cell.trim()))
}

/** @param {string} line @returns {string[]} */
function claimIdsOf(line) {
  const ids = []
  for (const [, id] of String(line).matchAll(VISIBLE_CLAIM_MARKER)) ids.push(id)
  for (const [, id] of String(line).matchAll(HIDDEN_CLAIM_MARKER)) ids.push(id)
  return ids
}

/** @param {string} body @returns {Set<number>} */
function citationNumbersOf(body) {
  /** @type {Set<number>} */
  const numbers = new Set()
  for (const [, group] of String(body).matchAll(CITATION_MARKER)) {
    for (const part of group.split(/[,，、]/)) {
      const single = Number(part.trim())
      if (Number.isInteger(single)) numbers.add(single)
    }
  }
  return numbers
}

/** Whitespace folded away, so a paragraph re-wrapped on paste still compares equal.
 *  @param {string} value @returns {string} */
function collapsed(value) {
  return String(value ?? '').replace(/\s+/g, '')
}

/** One line, because a finding that wraps over four of them is one nobody reads
 *  in the verdict envelope.
 *  @param {string} value @returns {string} */
function excerpt(value) {
  const line = String(value ?? '').trim().replace(/\s+/g, ' ')
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The section's claims, or null when the file cannot be read as claims at all.
 * Null and empty are kept apart: a run with no claims yet is at the start of the
 * job, and a run whose claim file does not parse has a syntax error to fix
 * before any binding rule below can say anything true about it.
 * @param {GateInput} input
 * @returns {{ claims: Record<string, unknown>[] | null, parseError: boolean }}
 */
function sectionClaims(input) {
  const raw = input.files.get(CLAIMS_FILE)
  if (raw == null || !raw.trim()) return { claims: null, parseError: false }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { claims: null, parseError: true }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.claims)) return { claims: null, parseError: true }
  return { claims: parsed.claims.filter(isRecord), parseError: false }
}

/**
 * The manuscript-section contract's own findings.
 *
 * Returns `{ issues, metrics }` rather than a whole verdict, and composes with
 * `validateReportShaped` in the registry — the same shape `appraisalContract`
 * uses. An earlier version was the whole validator and carried its own copies
 * of `requiredOutputIssues` and `proseHygieneIssues`, on the reasoning that
 * composing would report every absent file twice. That reasoning was circular:
 * the double report existed only because this module also did the pass. A
 * second copy of a shared rule is the drift
 * `clinicalEvidenceSingleImplementation.test.mjs` exists to prevent, and it is
 * a rule this contract does not own.
 *
 * @param {GateInput} input
 * @returns {{ issues: GateIssue[], metrics: Record<string, number> }}
 */
export function manuscriptSectionFindings(input) {
  /** @type {GateIssue[]} */
  const issues = []
  /** @param {string} code @param {string} message @param {string} [path] */
  const notice = (code, message, path) => issues.push(issue(code, message, { severity: 'advisory', ...(path ? { path } : {}) }))

  // The working copy, if the run forgot to remove it. Advisory, and deliberately
  // not a repair instruction the prompt has to remember: a file existing under a
  // fixed name is decidable, and SKILL.md asking the run to delete it was the
  // whole check until now.
  if (input.files.has(MANUSCRIPT_SCRATCH_FILE)) {
    issues.push(issue(
      'manuscript_scratch_file_delivered',
      `${MANUSCRIPT_SCRATCH_FILE} is the pre-edit snapshot, not a deliverable. Delete it before submitting: shipped, it is a second copy of the section that a reader cannot tell from the real one.`,
      { severity: 'advisory', path: MANUSCRIPT_SCRATCH_FILE, check: 'manuscript-scratch-file' },
    ))
  }

  const section = text(input, SECTION_FILE)
  const sectionLines = section.split('\n')
  const { claims, parseError } = sectionClaims(input)
  if (parseError) {
    notice(
      'manuscript_claims_unreadable',
      `${CLAIMS_FILE} does not parse as {"claims": [...]}. Fix that first: a value containing a double quote must escape it (\\"), and every string must close before the next key. Until it parses, nothing below has checked a single claim binding.`,
      CLAIMS_FILE,
    )
  }

  // Claim markers in the section, against the claims that exist.
  const markedInSection = new Set(sectionLines.flatMap(claimIdsOf))
  const declared = new Set((claims ?? []).map((claim) => String(claim.claimId ?? '')).filter(Boolean))
  const derivedIds = new Set((claims ?? [])
    .filter((claim) => String(claim.claimType ?? 'direct') === 'derived')
    .map((claim) => String(claim.claimId ?? ''))
    .filter(Boolean))

  if (claims) {
    const dangling = [...markedInSection].filter((id) => !declared.has(id)).sort()
    if (dangling.length) {
      notice(
        'manuscript_claim_unresolved',
        `the section marks ${dangling.slice(0, 5).join(', ')}${dangling.length > 5 ? ` and ${dangling.length - 5} more` : ''}, which ${CLAIMS_FILE} does not declare. A marker pointing at nothing is a sentence nobody can trace back to a source.`,
        SECTION_FILE,
      )
    }
    const unused = [...declared].filter((id) => !markedInSection.has(id)).sort()
    if (unused.length) {
      notice(
        'manuscript_claim_uncited',
        `${unused.length} claim(s) in ${CLAIMS_FILE} are marked on no sentence in the section: ${unused.slice(0, 5).join(', ')}. Either the sentence they support lost its marker in a rewrite, or the claim is no longer doing any work and should go.`,
        CLAIMS_FILE,
      )
    }
    // A derived result read as a measurement is the failure this whole capability
    // is most able to cause, so it is checked line by line rather than once per
    // document: the label has to be on the sentence a reader is looking at.
    const unmarked = []
    for (const [index, line] of sectionLines.entries()) {
      const derivedOnLine = claimIdsOf(line).filter((id) => derivedIds.has(id))
      if (derivedOnLine.length && !DERIVED_MARK_PATTERN.test(line)) unmarked.push({ line: index + 1, ids: derivedOnLine })
    }
    for (const entry of unmarked.slice(0, 5)) {
      issues.push(issue(
        'manuscript_derived_unmarked',
        `section line ${entry.line} states derived result ${entry.ids.join(', ')} without marking it as derived. Label it 〔推导〕 on that sentence so it is not read as a measurement.`,
        { severity: 'advisory', path: SECTION_FILE, line: entry.line },
      ))
    }
  }

  // The citation ledger, and the two directions a citation can fail.
  const ledgerRecords = csvRecords(text(input, LEDGER_FILE))
  const header = (ledgerRecords[0] ?? []).map((cell) => cell.trim().toLowerCase().replace(/[_\s]/g, ''))
  const claimIdColumn = header.indexOf('claimid')
  const referenceColumn = header.indexOf('referencenumber')
  const cited = citationNumbersOf(section)
  /** @type {Set<number>} */
  const ledgerNumbers = new Set()
  /** @type {Set<string>} */
  const ledgerClaims = new Set()
  if (ledgerRecords.length && (claimIdColumn < 0 || referenceColumn < 0)) {
    notice(
      'manuscript_ledger_schema',
      `${LEDGER_FILE} must have a header naming claimId and referenceNumber columns (any order, extra columns allowed); it has: ${header.join(', ')}. Without them no citation in the section can be resolved.`,
      LEDGER_FILE,
    )
  } else if (ledgerRecords.length) {
    for (const row of ledgerRecords.slice(1)) {
      const number = Number(String(row[referenceColumn] ?? '').trim())
      if (Number.isInteger(number)) ledgerNumbers.add(number)
      const claimId = String(row[claimIdColumn] ?? '').trim()
      if (claimId) ledgerClaims.add(claimId)
    }
    const unresolved = [...cited].filter((number) => !ledgerNumbers.has(number)).sort((left, right) => left - right)
    if (unresolved.length) {
      notice(
        'manuscript_citation_unresolved',
        `the section cites [${unresolved.slice(0, 8).join('], [')}], which ${LEDGER_FILE} has no row for. A citation index that resolves to nothing is the one error a reader finds and an author never does.`,
        SECTION_FILE,
      )
    }
    // Only when the section cites numerically at all. A methods section that
    // binds its sentences with claim markers and no `[n]` is using a different
    // citation style, not losing every source in the ledger — reporting all of
    // them there would be one finding per row for a section that is correct.
    const unread = cited.size
      ? [...ledgerNumbers].filter((number) => !cited.has(number)).sort((left, right) => left - right)
      : []
    if (unread.length) {
      notice(
        'manuscript_reference_uncited',
        `${LEDGER_FILE} carries reference ${unread.slice(0, 8).join(', ')} that the section never cites. A source that survived a rewrite while the sentence citing it did not is a reference list nobody can check against the text.`,
        LEDGER_FILE,
      )
    }
    // A derived claim cites no source of its own, so it is not a row here — its
    // inputs are, and they are what a reader traces. Everything else must be.
    if (claims) {
      const unledgered = [...declared].filter((id) => !derivedIds.has(id) && !ledgerClaims.has(id)).sort()
      if (unledgered.length) {
        notice(
          'manuscript_claim_unledgered',
          `${unledgered.length} non-derived claim(s) have no row in ${LEDGER_FILE}: ${unledgered.slice(0, 5).join(', ')}. The ledger is where a claim's quote is checked against the source it names.`,
          LEDGER_FILE,
        )
      }
    }
  }

  // Channel separation, decided by identity rather than by genre. A note the run
  // wrote and also left standing in the section is the one form of channel bleed
  // that can be found without judging what a revision note sounds like — and
  // judging that is the model's job, stated in the skill.
  //
  // One-directional by construction: a note that quotes the sentence it changed
  // ("改写前：X。改写后：Y。") is a longer paragraph than the section's, so the
  // section does not contain it and nothing fires. Only a paragraph that IS
  // section text matches.
  const notes = text(input, workspaceLayout.revisionNotesFile)
  if (notes.trim() && section.trim()) {
    const sectionFolded = collapsed(section)
    const bled = notes
      .split(/\n\s*\n/)
      .map((paragraph) => ({ paragraph, folded: collapsed(paragraph) }))
      .filter((entry) => entry.folded.length >= BACKSTAGE_PARAGRAPH_FLOOR && sectionFolded.includes(entry.folded))
    for (const entry of bled.slice(0, 3)) {
      notice(
        'manuscript_backstage_in_section',
        `a paragraph of ${workspaceLayout.revisionNotesFile} appears verbatim in the section: ${excerpt(entry.paragraph)}. The notes are where prose about the writing belongs; the section is what is left once it is gone.`,
        SECTION_FILE,
      )
    }
  }

  // Every finding this module makes is advisory — `notice()` is the only
  // constructor used below, and blocking for this kind stays where it already
  // was, on the manifest's required-output pass in the composed validator. A
  // contributor that could raise a `required` issue would be a seventh blocking
  // point arriving without a decision.
  return {
    issues,
    // The distribution a future decision to block would have to be argued from.
    metrics: {
      manuscriptSectionClaims: claims?.length ?? 0,
      manuscriptDerivedClaims: derivedIds.size,
      manuscriptClaimMarkers: markedInSection.size,
      manuscriptCitationsInSection: cited.size,
      manuscriptLedgerReferences: ledgerNumbers.size,
      manuscriptAdvisoryFindings: issues.filter((item) => item.severity === 'advisory').length,
    },
  }
}
