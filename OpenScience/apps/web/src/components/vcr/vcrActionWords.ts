/**
 * What the module's buttons say about what pressing them does (`@evimed/domain` `WORK_ACTION_KINDS`; module workspace audit 2026-11-01).
 *
 * A button that only fills the composer is a **draft**: it says 「让 AI …」 and carries the pencil, because nothing happens until the
 * person sends. A button that runs now on the server is a **start** and begins with 「开始」. The two used to look alike — 「生成虚拟患者」
 * only opened the conversation with a sentence, and 「开始评估」 beside it queued the jobs — so one table holds the words and the
 * pages cannot drift apart again.
 */

/** The front of a draft button: the work is the AI's once the person sends it. */
export const DRAFT_PREFIX = "让 AI ";

/**
 * 「比较版本」 meant three things: a button that opens a drawer ending in a draft, one that ran the engine's comparison now, and one
 * that queued a job. The first is a draft and says so; the other two start work and say 开始 (`COMPARE_START_LABEL`).
 */
export const COMPARE_DRAFT_LABEL = `${DRAFT_PREFIX}比较版本`;

/** Runs the comparison now, on the server. */
export const COMPARE_START_LABEL = "开始比较";

/** A draft that goes on with a step that did not finish. */
export const RESUME_LABEL = `${DRAFT_PREFIX}接着做`;

/**
 * Stopping reaches the whole study: it cancels the run and every open engine job, and holds the programme so that nothing in line is
 * taken up (`cancelVcrStudy`). A button on one step that said 「停止」 stopped the other steps too and said nothing about it.
 */
export const STOP_STUDY_LABEL = "停止整个研究";

/**
 * The one panel where a study's data is taken in, its field map confirmed and its snapshot frozen is called 数据接入 wherever it is
 * opened. Four buttons opened it as 数据接入, 数据来源, 接入数据 and 检查患者资料, so a reader could not tell they were one place.
 */
export const INTAKE_LABEL = "数据接入";

/** The one press that has the server look for trials for a patient now (`runVcrTrialSearch`). */
export const FIND_TRIALS_LABEL = "开始为该患者找试验";
