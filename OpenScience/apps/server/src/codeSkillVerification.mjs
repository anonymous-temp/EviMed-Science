import { scriptStaticIssues, toolConfigIssues } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/**
 * Proving a code skill runs before it is mounted into anyone's project.
 *
 * Hidden knowledge: the plan called for a new privileged controller operation,
 * `runtime.exec-verify`, behind a protocol-version bump. It is not needed. The
 * runtime controller already exposes `/v1/kernel/run`, which executes code in
 * the project's own container under the same sandbox, the same workspace
 * bound, and the same output cap — which is exactly what a code skill's self
 * test is. Adding a second way to execute code in a container would have meant
 * two privileged execution paths to keep in step, and the newer one would have
 * been the one nobody audited.
 *
 * So verification is a composition, not a capability: the static checks the
 * domain already decides, then the script's own `__main__` block and its test
 * file run through the path that already exists.
 *
 * The result is a verdict, never a mount. A script that passes here is still a
 * candidate; passing its own test says it runs, not that it helps.
 *
 * @module codeSkillVerification
 */

/** Ceiling for one verification, in milliseconds. A self test that needs longer
 *  than this is not a self test. */
export const CODE_SKILL_VERIFY_TIMEOUT_MS = 60_000;

/**
 * @typedef {object} CodeSkillVerdict
 * @property {boolean} ok
 * @property {{code: string, message: string, path?: string}[]} issues
 * @property {{path: string, status: string, output: string}[]} executions
 */

/** The `(stem, script, test, config)` groups an attached file set contains. */
export function codeSkillGroups(files) {
  /** @type {Map<string, {script?: string, test?: string, config?: string}>} */
  const groups = new Map();
  for (const path of Object.keys(files ?? {})) {
    const script = /^scripts\/([A-Za-z0-9_-]+)\.py$/.exec(path);
    const config = /^scripts\/([A-Za-z0-9_-]+)\.tool\.json$/.exec(path);
    const test = /^tests\/test_([A-Za-z0-9_-]+)\.py$/.exec(path);
    const stem = (script ?? config ?? test)?.[1];
    if (!stem) continue;
    const group = groups.get(stem) ?? {};
    if (script) group.script = path;
    if (config) group.config = path;
    if (test) group.test = path;
    groups.set(stem, group);
  }
  return groups;
}

/**
 * Run the static checks and then the script's own tests inside the project's
 * container.
 *
 * `runKernel` is injected rather than imported so this is testable without a
 * container, and because the only caller that has one is the composition root.
 * @param {{files: Record<string, string>, project: any, runKernel: (project: any, code: string, signal?: any, language?: string) => Promise<any>, signal?: any}} input
 * @returns {Promise<CodeSkillVerdict>}
 */
export async function verifyCodeSkill(input) {
  /** @type {{code: string, message: string, path?: string}[]} */
  const issues = [];
  /** @type {{path: string, status: string, output: string}[]} */
  const executions = [];
  const files = input.files ?? {};
  const groups = codeSkillGroups(files);
  if (!groups.size) return { ok: true, issues, executions };

  for (const [stem, group] of [...groups.entries()].sort()) {
    if (!group.script || !group.test || !group.config) {
      issues.push({
        code: "method_files_incomplete",
        message: `${stem} is missing its ${!group.script ? "script" : !group.test ? "test" : "tool schema"}; a code skill is all three or none.`,
        path: group.script ?? group.test ?? group.config,
      });
      continue;
    }
    issues.push(...scriptStaticIssues(files[group.script], group.script));
    let parsed = null;
    try {
      parsed = JSON.parse(files[group.config]);
    } catch {
      issues.push({ code: "method_tool_config_invalid", message: `${group.config} is not valid JSON.`, path: group.config });
    }
    if (parsed) issues.push(...toolConfigIssues(files[group.script], parsed, group.config, stem));
  }
  // Nothing is executed while a static check is failing. Running a script that
  // names an absent module or an absolute path only produces a second, less
  // legible version of the same finding.
  if (issues.length) return { ok: false, issues, executions };

  for (const [stem, group] of [...groups.entries()].sort()) {
    // The whole group in one program: the script's source, its test's source,
    // and the `__main__` self-call EvoDS's creation tool requires. One kernel
    // round trip per code skill, not three.
    const program = [
      `# code-skill verification for ${stem}`,
      files[/** @type {string} */ (group.script)],
      "",
      files[/** @type {string} */ (group.test)],
      "",
      "print('code-skill-verified:" + stem + "')",
    ].join("\n");
    let result;
    try {
      result = await input.runKernel(input.project, program, input.signal, "python");
    } catch (error) {
      throw new HttpError(503, "code_skill_verification_unavailable",
        `The runtime could not execute the ${stem} self test: ${error?.code ?? error?.message ?? "unavailable"}`);
    }
    const output = String(result?.output ?? result?.stdout ?? "");
    const failed = result?.status === "error" || result?.ok === false || !output.includes(`code-skill-verified:${stem}`);
    executions.push({ path: /** @type {string} */ (group.test), status: failed ? "failed" : "passed", output: output.slice(-2000) });
    if (failed) {
      issues.push({
        code: "method_script_self_test_failed",
        message: `${group.test} did not pass in the runtime container. Last output: ${output.slice(-400) || "(none)"}`,
        path: group.test,
      });
    }
  }
  return { ok: issues.length === 0, issues, executions };
}
