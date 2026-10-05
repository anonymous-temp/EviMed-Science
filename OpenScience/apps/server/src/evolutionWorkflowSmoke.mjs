import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "@evimed/domain";
import { readRunTranscript } from "./runTranscripts.mjs";
import { observedCall } from "./runProgress.mjs";

const explicitToolFailure = output => {
  if (typeof output !== "string") return false;
  try { const envelope=JSON.parse(output); return envelope?.ok === false || envelope?.status === "error"; } catch { return false; }
};
const canonicalTool = value => String(value ?? "").replace(/^mcp__evimed__/, "").split("/").at(-1);
/** Execute an unpublished instruction-only workflow in a bounded internal project. The input
 * contains no expected outputs. Only complete durable execution receipts establish tool use.
 * @param {any} dependencies */
export function createEvolutionWorkflowSmoke({ service, runs, store, readTranscript = readRunTranscript }) {
  return async ({ candidate, input, caseId, methodId, replicate = 0, signal }) => {
    const skill = candidate.files?.["SKILL.md"];
    if (typeof skill !== "string" || Object.keys(candidate.files ?? {}).some(name => name.endsWith(".py"))
      || !candidate.executionTools?.length) return { independent: true, executed: false, reason: "workflow-contract-incomplete" };
    const identity = createHash("sha256").update(canonicalJson([candidate.files, candidate.executionTools, input, caseId, methodId, replicate])).digest("hex").slice(0, 32);
    const userId = await service.owner(), projectId = `eval-paper-workflow-${identity}`;
    const { run, output } = await runs.execute({ userId, projectId, dispatchId: `evolution_workflow_${identity}`,
      capabilityId: "tool-builder", outputName: "tool-candidate.json", evaluationPolicy: { aliases: [], titles: [] },
      brief: `Execute the supplied instruction-only workflow on the supplied input with the actual existing tools. Execute in this root run; do not delegate to child agents. This is an isolated workflow smoke test, not tool development. Do not invent successful tool calls or expected outputs. Do not add code or new tools. Submit tool-candidate.json using evolution-tool-candidate: {id:"workflow-${identity}",track:${JSON.stringify(candidate.track ?? "M")},publicationKind:"skill",files:{"SKILL.md":<the supplied unchanged skill>},workflowOutput:<actual structured result>}. Missing inputs are a supported failure, not permission to fabricate data. The evaluator holds expected results separately. Task data:\n${JSON.stringify({ skill, input, executionTools: candidate.executionTools })}` }, { signal });
    const project = await store.requireProject(await store.userById(userId), projectId);
    let transcript;
    for (let attempt = 0; attempt < 10; attempt++) {
      transcript = await readTranscript(project, run.id);
      if (transcript?.header?.completeness === "complete") break;
      await delay(1000, undefined, { signal });
    }
    if (transcript?.header?.completeness !== "complete") return { independent: true, executed: false, runId: run.id, reason: "execution-transcript-incomplete" };
    const observed = new Set((transcript.messages ?? []).flatMap(message => message.parts ?? [])
      .filter(part => part.type === "tool" && !explicitToolFailure(part.output) && observedCall({ tool: part.tool, status: part.status, output: part.output }).ok === true)
      .map(part => canonicalTool(part.tool)));
    const toolsCalled = candidate.executionTools.filter(name => observed.has(canonicalTool(name)));
    return { independent: true, executed: run.status === "succeeded" && toolsCalled.length === candidate.executionTools.length,
      runId: run.id, toolsCalled, output: output.workflowOutput,
      transcriptHash: createHash("sha256").update(canonicalJson(transcript)).digest("hex") };
  };
}
