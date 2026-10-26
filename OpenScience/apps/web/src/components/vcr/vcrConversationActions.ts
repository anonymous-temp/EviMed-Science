import type { VcrStepKey } from "@/lib/vcrClient";
import type { StudyFrameApi } from "./studyFrameContext";
import { stepName } from "./vcrActivity";

/** Every failed/partial result resumes through the same unsent research request. */
export function resumeVcrStep(frame: StudyFrameApi | null, studyId: string, step: VcrStepKey) {
  frame?.openChat(`继续完成${stepName(step)}。请先检查失败原因和已保存的部分结果，复用有效内容。`, { kind: "step", studyId, objectId: step });
}
