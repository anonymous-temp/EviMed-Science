import assert from 'node:assert/strict';
import test from 'node:test';
import { runLedgerBoundaryControls } from '../extension-saas-acceptance-ledger.mjs';
test('actual isolated ledger enforces shared roles/revocation, protects canary and scopes idempotent metering', { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Explicit local PG fixture required; missing is not pass', timeout: 60000 }, async () => {
 const report = await runLedgerBoundaryControls({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL });
 assert.equal(report.qualified,false);assert.deepEqual(report.observations.map(row=>row.caseId),['SAAS-03','SAAS-05','SAAS-06','SAAS-14']);
 assert.equal(report.observations[0].actual.viewerWrite,'vcr_role_forbids');assert.equal(report.observations[0].actual.viewerRead,true);
 assert.equal(report.observations[1].actual.afterMembershipRevocation,'vcr_study_not_found');assert.equal(report.observations[1].actual.afterCredentialRevocation,false);
 assert.equal(report.observations[2].actual.plaintextScanMatches,0);assert.equal(report.observations[3].actual.sameJobCount,1);assert.equal(report.observations[3].actual.capRejected,1);
 assert.equal(report.cleanup.databaseDropped,true);
});
