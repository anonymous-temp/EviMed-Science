/**
 * People are available to their owner, but private by default at every egress boundary.
 * This is independent of `sensitive`, the owner's stronger suppression from recall and maps.
 * The kind survives capsule transfer; no additional privacy state is needed.
 * @param {unknown} record
 */
export function privateByDefault(record) {
  if (!record || typeof record !== "object") return false;
  const item = /** @type {{ nativeType?: string, kind?: string, factKind?: string, payload?: { factKind?: string } }} */ (record);
  return item.nativeType === "people" || item.kind === "person" || item.factKind === "person" || item.payload?.factKind === "person";
}
