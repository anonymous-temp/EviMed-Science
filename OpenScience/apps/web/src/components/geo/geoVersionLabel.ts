/** A compact label remains unambiguous among the versions currently displayed. */
export function geoVersionLabel(id: string, visibleIds: readonly (string | null | undefined)[]): string {
  const short = (value: string) => value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
  return visibleIds.some(other => other && other !== id && short(other) === short(id)) ? id : short(id);
}
