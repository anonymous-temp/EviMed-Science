/**
 * Bloat metrics for the capsule-proving harness.
 *
 * The latest snapshot gives the current size of a user's memory files; the
 * ingest rows give how many turns produced the adds, updates and deletes. One
 * "turn" is one user message: `userTurns` when the ingest row carries it,
 * otherwise half of `messages` rounded up.
 *
 * Files under `observations/` are excluded from every metric because they are
 * not read as memory by the product.
 *
 * Plain Node 22 ESM, no dependencies.
 *
 * @module capsule-proving/run/bloat
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Normalise a snapshot path and strip an optional `memories/` prefix, so the
 * top-level component is the memory type or the root file name.
 *
 * @param {string} path
 * @returns {string[]}
 */
function pathParts(path) {
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (parts[0] === 'memories') parts.shift();
  return parts;
}

/** @param {string[]} parts @returns {boolean} */
function isObservation(parts) {
  return parts.some((part) => part === 'observations');
}

/**
 * Turn count of one ingest row. `userTurns` wins when present (including 0);
 * otherwise a conversation of `messages` alternating messages has half as many
 * user turns, rounded up.
 *
 * @param {Record<string, any>} row
 * @returns {number}
 */
function turnsOf(row) {
  if (isFiniteNumber(row.userTurns) && row.userTurns >= 0) return row.userTurns;
  const messages = isFiniteNumber(row.messages)
    ? row.messages
    : Array.isArray(row.messages)
      ? row.messages.length
      : 0;
  return Math.ceil(messages / 2);
}

/** @param {unknown} value @returns {number} */
function operationCount(value) {
  return isFiniteNumber(value) && value >= 0 ? value : 0;
}

/**
 * Compute file, character and operation bloat from snapshots and ingest rows.
 *
 * @param {object} input
 * @param {Array<Record<string, any>>} [input.snapshots] snapshot objects in order; the last is current
 * @param {Array<Record<string, any>>} [input.ingestRows] rows written by the ingest step
 * @returns {{
 *   files: number,
 *   chars: number,
 *   byType: Record<string, { files: number, chars: number }>,
 *   addedPer100Turns: number,
 *   updatesPer100Turns: number,
 *   deletesPer100Turns: number,
 *   turns: number,
 * }}
 */
export function bloatMetrics({ snapshots, ingestRows } = {}) {
  const snapshotList = Array.isArray(snapshots) ? snapshots : [];
  const ingestList = Array.isArray(ingestRows) ? ingestRows : [];
  const latest = snapshotList.length > 0 ? snapshotList[snapshotList.length - 1] : null;

  /** @type {Record<string, { files: number, chars: number }>} */
  const byType = {};
  let files = 0;
  let chars = 0;

  if (isPlainObject(latest) && isPlainObject(latest.files)) {
    const paths = Object.keys(latest.files).sort();
    for (const path of paths) {
      const parts = pathParts(path);
      if (parts.length === 0 || isObservation(parts)) continue;
      const content = latest.files[path];
      const length = typeof content === 'string' ? content.length : String(content ?? '').length;
      const type = parts[0];
      if (!Object.hasOwn(byType, type)) byType[type] = { files: 0, chars: 0 };
      byType[type].files += 1;
      byType[type].chars += length;
      files += 1;
      chars += length;
    }
  }

  let turns = 0;
  let adds = 0;
  let updates = 0;
  let deletes = 0;
  for (const row of ingestList) {
    if (!isPlainObject(row)) continue;
    turns += turnsOf(row);
    const operations = isPlainObject(row.operations) ? row.operations : {};
    adds += operationCount(operations.adds);
    updates += operationCount(operations.updates);
    deletes += operationCount(operations.deletes);
  }

  /** @param {number} total @returns {number} */
  const per100 = (total) => (turns === 0 ? 0 : (total / turns) * 100);

  return {
    files,
    chars,
    byType,
    addedPer100Turns: per100(adds),
    updatesPer100Turns: per100(updates),
    deletesPer100Turns: per100(deletes),
    turns,
  };
}
