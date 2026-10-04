import { describe, expect, it } from "vitest";
import { CONNECTOR_CREDENTIALS } from "@evimed/domain";
import type { WebConnector } from "@/lib/apiClient";
import { continuationText, runCredentialNeeds, runCredentialSentence } from "./runCredential";

const connector = (id: string, source: WebConnector["source"]) => ({ id, source } as unknown as WebConnector);
const finished = { status: "succeeded" as const, connectorNeeds: ["umls", "semantic-scholar"] };

describe("the data sources a finished run went without", () => {
  it("reads the ledger's closed list, in the order the run met them, titled from the registry", () => {
    expect(runCredentialNeeds(finished)).toEqual([
      { connectorId: "umls", title: "UMLS", state: "missing" },
      { connectorId: "semantic-scholar", title: "Semantic Scholar", state: "missing" },
    ]);
    expect(runCredentialSentence({ connectorId: "umls", title: "UMLS", state: "missing" })).toBe("UMLS 还没有配置，相关部分已跳过。");
    // The platform's own evidence API is a connector since 2026-10-04.
    expect(runCredentialNeeds({ status: "succeeded", connectorNeeds: ["evimed-evidence"] })[0].title).toBe("EviMed 证据库");
    expect(CONNECTOR_CREDENTIALS.some((spec) => spec.id === "evimed-evidence")).toBe(true);
  });

  it("says a source is configured once something serves it, and still missing while nothing does", () => {
    const list = [connector("umls", "user"), connector("semantic-scholar", "none")];
    expect(runCredentialNeeds(finished, list).map((need) => need.state)).toEqual(["configured", "missing"]);
    expect(runCredentialNeeds(finished, [connector("umls", "deployment")])[0].state).toBe("configured");
    // A connector list that has not been read is not a reason to hide the form.
    expect(runCredentialNeeds(finished, null).map((need) => need.state)).toEqual(["missing", "missing"]);
  });

  it("says nothing for a run that is going, did not finish, or left nothing out, and drops what the registry does not know", () => {
    expect(runCredentialNeeds({ ...finished, status: "running" })).toEqual([]);
    expect(runCredentialNeeds({ ...finished, status: "failed" })).toEqual([]);
    expect(runCredentialNeeds({ status: "succeeded" })).toEqual([]);
    expect(runCredentialNeeds({ status: "succeeded", connectorNeeds: [] })).toEqual([]);
    expect(runCredentialNeeds(null)).toEqual([]);
    expect(runCredentialNeeds({ status: "succeeded", connectorNeeds: ["not-a-connector", "umls", "umls"] }).map((need) => need.connectorId)).toEqual(["umls"]);
  });

  it("words the one-click follow-up in the researcher's voice and names only the sources", () => {
    expect(continuationText(["UMLS"])).toBe("我已经配置了 UMLS，请用它补做刚才因为缺少它而跳过的部分。");
    expect(continuationText(["UMLS", "CORE"])).toBe("我已经配置了 UMLS、CORE，请用它们补做刚才因为缺少它们而跳过的部分。");
  });
});
