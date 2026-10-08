/**
 * The two runtime tools that create and change a scheduled task from a conversation (`schedule_task`, `update_task`; design reference
 * §14.2 「在对话里创建与修改」, N-13): what they share between the control plane's gateway, the runtime's MCP tool and the codes a
 * failure carries.
 *
 * Hidden knowledge:
 *
 *  - A task the conversation creates is the researcher's own task, made the way the task form makes one: the platform's default budgets
 *    and stopping rules (the owner's rulings of 2026-09-19 and 2026-09-20), started at once, with no step to approve. The tool is the
 *    form's twin, not a proposal.
 *  - The conversation names a moment, a frequency and what to keep doing. It never names an account, a project or a price: the runtime's
 *    own token decides whose task it is, and the budget is the platform's.
 *  - An execution of a task does not make tasks (`task_tools_not_in_conversation`): a task that schedules tasks is a loop nobody asked for.
 */

/** The longest instruction a task keeps (the same ceiling the control plane's task service holds an instruction to). */
export const TASK_INSTRUCTION_MAX_CHARS = 20_000
/** The longest title a task keeps. */
export const TASK_TITLE_MAX_CHARS = 200
/** How many tasks one project may hold before the conversation is told to delete or pause one first (a limit that protects the account's spend from a loop, not the researcher from themselves). */
export const TASK_TOOLS_DEFAULT_MAX_TASKS = 30

/**
 * Every code the two tools' gateway answers with. The run's own mistakes (a malformed schedule, a task that is not there) are
 * `TASK_TOOL_RUN_FIXES`; the rest are the feature being off or briefly unavailable, which the conversation reports plainly and goes on from.
 */
export const TASK_TOOL_ERROR_CODES = Object.freeze([
  'task_tools_disabled', 'task_tools_unconfigured', 'task_tools_unavailable', 'task_tools_gateway_unreachable',
  'task_tools_gateway_token_missing', 'task_tools_gateway_token_invalid', 'task_tools_rate_limited',
  'task_tools_response_invalid', 'task_tools_response_too_large', 'task_tools_upstream_error',
  'task_tools_not_in_conversation', 'task_limit_reached', 'task_revision_conflict',
  'task_tools_request_invalid', 'task_tools_request_too_large', 'task_instruction_invalid', 'task_title_invalid',
  'task_schedule_invalid', 'task_schedule_in_past', 'task_id_invalid', 'task_not_found', 'task_update_empty', 'task_paused_invalid',
])

/** The codes that are the run's to fix: the call said something the tool cannot act on. */
export const TASK_TOOL_RUN_FIXES = Object.freeze([
  'task_tools_request_invalid', 'task_tools_request_too_large', 'task_instruction_invalid', 'task_title_invalid',
  'task_schedule_invalid', 'task_schedule_in_past', 'task_id_invalid', 'task_not_found', 'task_update_empty', 'task_paused_invalid',
])

/** What a researcher is told when a task tool could not do what was asked; the conversation then says so itself. */
export const TASK_TOOL_ERROR_MESSAGE_ZH = '定时任务这次没能安排或修改；可以在“定时任务”页里直接新建或修改。'
