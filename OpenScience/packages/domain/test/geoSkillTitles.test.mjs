import assert from 'node:assert/strict'
import test from 'node:test'
import { GEO_SKILL_TITLES, geoSkillDisplayTitle } from '../src/skillDisplay.mjs'

// Reviewed installed pack metadata snapshot, 2026-10-26. Names only; no method text.
const reviewedNames = [
  "geo-build-evidence-map",
  "geo-calibrate-targets",
  "geo-care-nodes",
  "geo-collect-project-inputs",
  "geo-configure-pricing",
  "geo-content-pilot",
  "geo-create-baseline-comparison-report",
  "geo-create-deep-research-paper",
  "geo-create-derived-content",
  "geo-create-distribution-plan",
  "geo-create-feasibility-report",
  "geo-create-knowledge-cards",
  "geo-create-kpi-forecast-workbook",
  "geo-create-kpi-methodology-manual",
  "geo-create-medical-review",
  "geo-create-methodology-manual",
  "geo-create-monitoring-report",
  "geo-create-pilot-plan",
  "geo-create-platform-scenario-report",
  "geo-create-proposal-deck",
  "geo-create-report-agent-spec",
  "geo-create-revision-checklist",
  "geo-create-semantic-evidence-methodology",
  "geo-create-semantic-evidence-report",
  "geo-create-semantic-probe-workbook",
  "geo-create-single-wedge-report",
  "geo-create-strategy-report",
  "geo-create-visibility-index-workbook",
  "geo-define-kpi-contract",
  "geo-demand-map",
  "geo-design-semantic-pools",
  "geo-evidence-frontier",
  "geo-gate-compliance-channels",
  "geo-map-competitor-landscape",
  "geo-map-product-variants",
  "geo-patient-journey",
  "geo-plan-baseline-probe",
  "geo-proposal-brief",
  "geo-run-assessment-package",
  "geo-run-execution-package",
  "geo-run-preflight-qa",
  "geo-run-project-preflight",
  "geo-run-proposal-package",
  "geo-select-battlefield",
  "geo-specify-deliverables",
  "geo-subtype-tree",
  "geo-verify-product-label",
  "geo-visibility-forecast"
]

test('every reviewed GEO skill has one Chinese task title and no private method content', () => {
  assert.deepEqual(Object.keys(GEO_SKILL_TITLES).sort(), reviewedNames.sort())
  for (const [name, title] of Object.entries(GEO_SKILL_TITLES)) {
    assert.match(title, /[㐀-鿿]/u, name)
    assert.ok(title.length <= 40, name)
    assert.equal(geoSkillDisplayTitle(name, name), title)
    assert.equal(geoSkillDisplayTitle(name, 'Existing English metadata'), title)
  }
})

test('Chinese metadata takes precedence and an unknown task is never translated by guessing', () => {
  assert.equal(geoSkillDisplayTitle('geo-care-nodes', '已有中文标题'), '已有中文标题')
  assert.equal(geoSkillDisplayTitle('unreviewed', 'Author Provided Name'), 'Author Provided Name')
})
