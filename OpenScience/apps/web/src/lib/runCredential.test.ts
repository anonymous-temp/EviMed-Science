import { describe, expect, it } from "vitest";
import type { WebConnector } from "@/lib/apiClient";
import { runCredentialNeed, runCredentialSentence } from "./runCredential";

const connector = (id: string, needsAttention: boolean) => ({ id, needsAttention } as unknown as WebConnector);
const failed = { status: "failed" as const, errorCode: null, errorSubCode: null, agentId: null, effectiveAgentId: null };

describe("the one source a failed run needed", () => {
  it("is named by the gateway's own code", () => {
    const need = runCredentialNeed({ ...failed, errorCode: "public_source_semantic_scholar_credential_missing" });
    expect(need).toEqual({ connectorId: "semantic-scholar", title: "Semantic Scholar", cause: "code" });
    expect(runCredentialSentence(need!)).toBe("这次运行因缺少 Semantic Scholar 的凭据没能继续。");
    expect(runCredentialNeed({ ...failed, errorSubCode: "public_source_opengwas_credential_missing" })?.connectorId).toBe("opengwas");
  });

  it("is stated as a dependency when the capability needs a source nobody configured", () => {
    const need = runCredentialNeed({ ...failed, effectiveAgentId: "mendelian-randomization" }, [connector("opengwas", true)]);
    expect(need).toMatchObject({ connectorId: "opengwas", cause: "capability" });
    expect(runCredentialSentence(need!)).toContain("这项能力需要 OpenGWAS 的凭据");
    // Configured, or not a dependency of this capability: nothing to say.
    expect(runCredentialNeed({ ...failed, effectiveAgentId: "mendelian-randomization" }, [connector("opengwas", false)])).toBeNull();
    expect(runCredentialNeed({ ...failed, effectiveAgentId: "clinical-evidence-synthesis" }, [connector("opengwas", true)])).toBeNull();
  });

  it("says nothing about a run that did not fail, or a code for no known source", () => {
    expect(runCredentialNeed({ ...failed, status: "succeeded", errorCode: "public_source_opengwas_credential_missing" })).toBeNull();
    expect(runCredentialNeed({ ...failed, errorCode: "public_source_nonexistent_credential_missing" })).toBeNull();
  });
});
