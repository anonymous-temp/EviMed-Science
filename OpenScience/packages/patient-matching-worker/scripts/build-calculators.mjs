import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
const source = new URL('../../../runtime/mcp/evimed-research/', import.meta.url);
const destination = new URL('../python/clinical/', import.meta.url);
await mkdir(destination, { recursive: true });
const files = ['clinical_scores.py', 'clinical_score_kit.py', 'clinical_score_points.py', 'clinical_score_formulas.py', 'clinical_score_verification.py'];
const digests = {};
for (const name of files) {
  const bytes = await readFile(new URL(name, source));
  await copyFile(new URL(name, source), new URL(name, destination));
  digests[name] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(new URL('../python/calculators.sha256.json', import.meta.url), `${JSON.stringify(digests, null, 2)}\n`);
