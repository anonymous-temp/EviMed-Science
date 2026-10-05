/** Discovery metadata from the actual immutable runtime mount, never candidate bodies or evaluator data.
 * @param {string} text @param {any[]} pins @param {string|null} capabilityId */
export function renderEvolutionToolContext(text, pins, capabilityId) {
  if (!capabilityId || !Array.isArray(pins)) return '';
  const mentioned = value => {
    const index = text.indexOf(value);
    return index >= 0 && !/[A-Za-z0-9_-]/.test(text[index - 1] ?? '') && !/[A-Za-z0-9_-]/.test(text[index + value.length] ?? '');
  };
  const cards = pins.filter(pin => pin.id !== 'platform-tool-search' && /^[A-Za-z0-9_-]{1,100}$/.test(pin.id) && /^platform-[a-f0-9]{24}$/.test(pin.nativeName) && /^sha256:[a-f0-9]{64}$/.test(pin.digest) && Number.isSafeInteger(pin.revision) && pin.revision > 0 && (!pin.capabilityIds?.length || pin.capabilityIds.includes(capabilityId)) && (mentioned(pin.id) || mentioned(pin.nativeName))).flatMap(pin => {
    const files = (pin.files ?? []).map(file => file.path), instructions = files.includes('SKILL.md') ? 'SKILL.md' : files.includes('INSTRUCTIONS.md') ? 'INSTRUCTIONS.md' : null;
    if (!instructions) return [];
    const base = `$EVIMED_PLATFORM_SKILLS_DIR/${pin.nativeName}`;
    return [{ id: pin.id, digest: pin.digest, revision: pin.revision, nativeName: pin.nativeName, instructionPath: `${base}/${instructions}`, ...(pin.publicationKind === 'isolated-tool' && files.includes('scripts/invoke_isolated.py') ? { invokeClientPath: `${base}/scripts/invoke_isolated.py` } : {}) }];
  }).slice(0, 30);
  if (!cards.length) return '';
  return `\n\nPlatform tools explicitly requested in this run (immutable installed metadata):\n${JSON.stringify(cards)}\nRead each requested tool's instructionPath before execution. For isolated tools execute only its platform invokeClientPath with python3 and JSON arguments on stdin; expand $EVIMED_PLATFORM_SKILLS_DIR from the runtime environment. Use the installed implementation, preserving its exact revision, rather than recreating its calculation in workspace code.\n`;
}
