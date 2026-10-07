/** Scoped engine jobs and runtime J18 only; provider credentials stay here. */
import { verifyEngineModelToken } from "./modelGatewayEngineTokens.mjs";
import { HttpError, readBody, sendError, sendJson } from "./security.mjs";
export const JUDGE_GATEWAY_PATH = "/internal/judge/v1/ask";
const allowed = {
  J8: ["peer-review"],
  J9: ["mendelian-randomization"],
  J15: ["research-topic-selection"],
  J18: ["meta-analysis"],
  J19: ["research-topic-selection"],
  J20: ["drug-safety-analysis"],
  "meta-evidence-role": ["meta-analysis"],
  "peer-review-checklist": ["peer-review"],
};
/** @param {{config:any,judgeService:any,runtimeManager?:any}} deps */
export function createJudgeGatewayHandler({ config, judgeService, runtimeManager }) {
  return async (req, res) => {
    try {
      if (req.method !== "POST")
        throw new HttpError(405, "judge_method_invalid", "POST is required.");
      const bearer = /^Bearer (\S+)$/i.exec(
        String(req.headers.authorization ?? ""),
      );
      let caller;
      let runtime = false;
      try {
        caller = verifyEngineModelToken(bearer?.[1], { secret: config.modelGatewaySigningSecret });
      } catch {
        try { caller = runtimeManager?.assertActiveModelGatewayToken(bearer?.[1]); }
        catch { throw new HttpError(401, "judge_token_invalid", "Judge authentication failed."); }
        if (!caller) throw new HttpError(401, "judge_token_invalid", "Judge authentication failed.");
        runtime = true;
      }
      if (!runtime && config.engineModelGatewayEnabled !== true)
        throw new HttpError(
          503,
          "judge_gateway_disabled",
          "Engine judgement is disabled.",
        );
      let body;
      try {
        body = JSON.parse((await readBody(req, 128 * 1024)).toString("utf8"));
      } catch {
        throw new HttpError(
          400,
          "judge_request_invalid",
          "Invalid judge request.",
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["site", "input"].includes(key)) ||
        !(runtime ? body.site === "J18" : body.site === "comparison"
          ? ["peer-review", "mendelian-randomization"].includes(
              caller.engine.kind,
            )
          : typeof body.site === "string" && Object.hasOwn(allowed, body.site) && allowed[body.site].includes(caller.engine.kind))
      )
        throw new HttpError(
          400,
          "judge_request_invalid",
          "This site is not available to this engine.",
        );
      const context = {
        engineAuthenticated: !runtime,
        userId: caller.userId,
        projectId: caller.projectId,
        runId: caller.runId,
        taskId: runtime ? null : caller.engine.jobId,
        module: runtime ? "runtime-evidence" : caller.engine.kind,
        limits: {
          daily: caller.dailyLimit,
          weekly: caller.weeklyLimit,
          run: caller.runLimit,
        },
      };
      const result =
        body.site === "comparison"
          ? await judgeService.compareEngine(body.input, context)
          : await judgeService.judge(body.site, body.input, context);
      const { answers, ...publicResult } = result;
      void answers;
      sendJson(res, 200, publicResult);
    } catch (error) {
      sendError(res, error);
    }
  };
}
