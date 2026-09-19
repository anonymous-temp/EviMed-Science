// Artifact provenance (P0-3): turn the agent's successful file-writing tool
// calls into version records in `.openscience/provenance.jsonl`, and read them
// back for the artifact History view. Pure derivation is separated from the
// Tauri bridge so it can be unit-tested without a desktop shell.
import type { ToolUpdatedEvent } from "@/lib/kernelEvents";
import type { ProvenanceRecord } from "@ai4s/shared";
import { hasWebApi, invokeCommand } from "./apiClient";
import { deriveArtifact } from "./artifacts";

export interface ProvenanceInput {
  callId: string;
  path: string;
  tool: string;
  /** Text the tool wrote, when it carried it (write/edit). */
  content?: string;
  log: string;
}

/**
 * Derive a provenance record from a completed tool call, or `null` when the
 * event is not a version-worthy write (failures, reads, non-file tools).
 */
export function provenanceInputFromEvent(event: ToolUpdatedEvent): ProvenanceInput | null {
  if (event.status !== "success") return null;
  const artifact = deriveArtifact(event);
  if (!artifact) return null;
  // Write-tool titles are usually just the file path — redundant next to the
  // record's own path field, so keep only titles that say something more.
  const title = event.title?.trim();
  const log =
    title && !title.endsWith(artifact.filename) ? title : `${event.tool} → ${artifact.path}`;
  return { callId: event.callId, path: artifact.path, tool: event.tool, content: artifact.content, log };
}

/** All recorded versions of one artifact, oldest first ([] in browser dev). */
export async function listProvenance(path: string): Promise<ProvenanceRecord[]> {
  if (!hasWebApi) return [];
  try {
    return await invokeCommand<ProvenanceRecord[]>("list_provenance", { path });
  } catch {
    return [];
  }
}

/** The captured `pip freeze` list for a package snapshot hash (null if unreadable). */
export async function readEnvLockfile(hash: string): Promise<string | null> {
  if (!hasWebApi) return null;
  try {
    return await invokeCommand<string>("read_env_lockfile", { hash });
  } catch {
    return null;
  }
}
