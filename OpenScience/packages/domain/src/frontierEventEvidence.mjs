/** Count preserved study identities, merging rows that share a registry id, DOI or PMID.
 * Reports without an identity remain unlinked; titles and publisher names never establish a study.
 * @param {Array<{owner?: string, studyIds?: string[]}>} reports
 */
export function frontierEventEvidenceCounts(reports) {
  /** @type {Set<string>[]} */
  const groups = [];
  let unlinkedReports = 0;
  for (const report of reports) {
    const ids = new Set((report.studyIds ?? []).filter(Boolean));
    if (!ids.size) { unlinkedReports += 1; continue; }
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      if ([...ids].some(id => groups[i].has(id))) {
        for (const id of groups[i]) ids.add(id);
        groups.splice(i, 1);
      }
    }
    groups.push(ids);
  }
  return { reports: reports.length, institutions: new Set(reports.map(r => r.owner).filter(Boolean)).size,
    studies: groups.length, unlinkedReports };
}
