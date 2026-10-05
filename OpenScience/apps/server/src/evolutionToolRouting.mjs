/**
 * A published tool reaches a conversation through the runtime's own catalogue, never through routing: the tools a
 * capability has are mounted as native skills in a run of that capability, behind one search entry when there are
 * many, and a researcher who wants a capability's line chooses it (`line`). Which capability a question belongs to
 * is the classifier's judgement; no tool name or verb in the question decides it, and nothing here reads the
 * tool list on a prompt.
 */

/** Only the supply publisher mints native identities. @param {any} publication */
export const trustedEvolutionNativeName = publication => /^platform-[a-f0-9]{24}$/.test(publication?.nativeName ?? '') ? publication.nativeName : undefined;
