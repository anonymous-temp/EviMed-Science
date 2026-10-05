/** Scientific identity and invocation scope belong to the admitted research card, never model output.
 * @param {any} output @param {any} card */
export function bindEvolutionCandidateIdentity(output,card) {
  return {...output,track:card.track,methodId:card.methodId,toolKind:card.toolKind,
    capabilityIds:Array.isArray(card.capabilityIds)?[...card.capabilityIds]:[]};
}
