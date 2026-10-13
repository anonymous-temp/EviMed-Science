// The per-claim marks (verified / quote_not_found / source_unavailable / no_quote / derived) a reader sees as ✓ / ⚠, computed by
// the tree's own domain function over a delivered evidence matrix and the preserved sources the run left in the workspace.
//   node claim_marks.mjs <OpenScience tree> <matrix.json> <directory holding the workspace's text files>
import fs from 'node:fs/promises';
import path from 'node:path';

const [tree, matrixFile, sourcesDir] = process.argv.slice(2);
const { claimVerification } = await import(path.join(tree, 'packages/domain/src/clinicalEvidence.mjs'));
const matrix = JSON.parse(await fs.readFile(matrixFile, 'utf8'));
const sourceArtifacts = {};
const walk = async (dir, rel) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(next, relative);
    else sourceArtifacts[relative] = await fs.readFile(next, 'utf8').catch(() => '');
  }
};
await walk(sourcesDir, '');
const result = claimVerification({ matrix, sourceArtifacts });
console.log(JSON.stringify({ counts: result.counts, claims: result.claims.length }));
