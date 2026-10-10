// The resident profile as a dispatch site receives it (`ResidentProfiles.forDispatch`), for the tests that compose the whole
// app and decide what the memory hands a run. Before review M6 they stubbed the substrate's recall; a dispatch reads the
// standing profile now, and the substrate is the recall tool's.
import { renderMemoryContext } from "../../src/researchContext.mjs";

/** A researcher with no profile: nothing is handed to the run, and nothing is recorded as delivered. */
export const noProfile = async () => ({ text: "", memories: [], due: false, reason: "empty", omitted: 0, delivered: async () => {} });

/**
 * A profile of these memories, due at this dispatch.
 * @param {any[]} memories
 */
export const profileOf = (memories) => async () => ({
  text: renderMemoryContext(memories), memories, due: true, reason: "first", omitted: 0, delivered: async () => {},
});
