/**
 * The capabilities a GEO conversation can be bound to. A conversation bound to
 * any of them carries the “循证 GEO” chip. The frame holds the same list in
 * its vocabulary (`packages/harness-port/src/runtimeUiFrame.mjs`, `geo`); both
 * belong in the domain's GEO vocabulary once it exists.
 *
 * On its own so the conversation frame can ask whether a conversation is a GEO
 * one without loading `geoText.ts` (the engines, starters and the domain's GEO
 * vocabulary), which only a GEO conversation needs.
 */
export const GEO_CAPABILITY_IDS: readonly string[] = Object.freeze(["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]);
