import { productRequest } from "./productClient";
import type { WebAgentRun, WebRuntimeStartStatus, PreservedConversationHistory } from "./apiClient";
import type { ReplyCheck } from "./replyChecks";

export interface GeoConversationScope { kind: "geo"; geoProjectId: string; sessionId: string }
export interface GeoConversationDescriptor { scope: GeoConversationScope; projectId: string; projectName: string; sessionId: string }
export type GeoConversationOpenTarget = { kind: "primary" } | { kind: "context"; referenceId: string } | { kind: "session"; sessionId: string };
export function openGeoConversation(geoId: string, target: GeoConversationOpenTarget): Promise<GeoConversationDescriptor> {
  return productRequest(`/geo/projects/${encodeURIComponent(geoId)}/conversation/open`, "POST", { target });
}
const base = (scope: GeoConversationScope) => `/geo/projects/${encodeURIComponent(scope.geoProjectId)}/conversation/${encodeURIComponent(scope.sessionId)}`;
export const geoConversationRuns = (scope: GeoConversationScope) => productRequest<WebAgentRun[]>(`${base(scope)}/runs`);
export const geoConversationHistory = (scope: GeoConversationScope) => productRequest<PreservedConversationHistory>(`${base(scope)}/history`);
export const geoConversationStatus = (scope: GeoConversationScope) => productRequest<WebRuntimeStartStatus>(`${base(scope)}/status`);
export const startGeoConversation = (scope: GeoConversationScope) => productRequest<WebRuntimeStartStatus>(`${base(scope)}/start`, "POST", {});
export const geoConversationCapability = async (scope: GeoConversationScope) => (await productRequest<{capabilityId:string|null}>(`${base(scope)}/capability`)).capabilityId;
export const geoConversationChecks = async (scope: GeoConversationScope) => (await productRequest<{checks:ReplyCheck[]}>(`${base(scope)}/reply-checks`)).checks;
export const geoConversationSources = async (scope: GeoConversationScope) => (await productRequest<{items:Array<{id:string;title:string}>}>(`${base(scope)}/sources`)).items;
export const geoConversationSourceScope = (scope: GeoConversationScope, sourceIds?: string[]) => productRequest<{sourceScope:string[]|null;originReference?:null}>(`${base(scope)}/source-scope`, sourceIds === undefined ? "GET" : "PUT", sourceIds === undefined ? undefined : {sourceIds});
