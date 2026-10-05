/** Actual server-minted call receipts, never transcript assertions or retrieval observations. */
export function conversationReceipts(rows, {userId,projectId,runId,toolId,digest,revision,index}) {
  const expected = index === 0 ? true : index === 4 ? false : null;
  const receipts = rows.filter(row => {
    const value=row.payload;
    return row.id && value?.callId && value.userId===userId && value.projectId===projectId && value.runId===runId
      && value.toolId===toolId && value.digest===digest && value.revision===revision && typeof value.result?.ok==='boolean';
  });
  const matches = row => expected === null || (expected === true
    ? row.payload.result.ok === true && row.payload.resultEvidence?.substantive === true && row.payload.resultEvidence?.explicitlyUnsupported !== true
    : row.payload.result.ok === false || row.payload.resultEvidence?.explicitlyUnsupported === true);
  return {required:expected!==null,passed:expected===null || receipts.some(matches),
    receiptIds:receipts.filter(matches).map(row=>row.id)};
}
