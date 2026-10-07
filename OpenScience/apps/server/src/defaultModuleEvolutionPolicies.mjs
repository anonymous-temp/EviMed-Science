import { FRONTIER_SCREEN_INSTRUCTIONS, FRONTIER_EDIT_INSTRUCTIONS } from "./frontierEditor.mjs";
import { FRONTIER_SELECT_THRESHOLD_DEFAULT } from "./frontierPipeline.mjs";
import { AUTOPILOT_PLANNER_INSTRUCTIONS } from "./autopilotNextAction.mjs";

/** Mutable surfaces only. Dynamic researcher context, safety and answer contracts remain in production code. */
export const DEFAULT_MODULE_EVOLUTION_POLICIES = Object.freeze({
  frontier: {screenInstructions: FRONTIER_SCREEN_INSTRUCTIONS,editInstructions: FRONTIER_EDIT_INSTRUCTIONS,selectionThreshold: FRONTIER_SELECT_THRESHOLD_DEFAULT},
  autopilot: {plannerInstructions: AUTOPILOT_PLANNER_INSTRUCTIONS},
  geo: {supplements: []},
});
