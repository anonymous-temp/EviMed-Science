// Synthetic examples of the verified upstream response constructors; see provenance.json.
export const healthResponse = { status: "healthy", service: "memos", version: "1.0.1" };
export const exampleRecord = { entryId: "entry-one", content: "Prefer concise methods explanations.", provenanceIds: ["run-one", "message-one"] };
export function addResponse(cubeId, id = "memory-one") {
  return { code: 200, message: "Memory added successfully", data: [
    { memory: exampleRecord.content, memory_id: id, memory_type: "WorkingMemory", cube_id: cubeId },
  ] };
}
export function searchResponse(userId, cubeId, { total, id = "memory-one" } = {}) {
  return { code: 200, message: "Search completed successfully", data: {
    text_mem: [{ cube_id: cubeId, ...(total === undefined ? {} : { total_nodes: total }), memories: [{
      id, memory: exampleRecord.content, ref_id: "[memory]", metadata: {
        user_id: userId, memory_type: "WorkingMemory", status: "activated", relativity: 0.9,
        info: { evimed_entry_id: exampleRecord.entryId, evimed_provenance_ids: exampleRecord.provenanceIds },
      },
    }] }], pref_mem: [], tool_mem: [], skill_mem: [],
  } };
}
export const deleteResponse = { code: 200, message: "Memories deleted successfully", data: { status: "success" } };
