/**
 * An authorized attachment attempt is user activity, including one whose upstream outcome is unknown.
 * Persist before forwarding; this is neither an upload receipt nor a claim that bytes were saved.
 * @param {any} documents @param {{userId: string, id: string}} project
 */
export async function recordNativeUploadAttempt(documents, project) {
  const id = `native-upload-attempt:${project.id}`;
  const existing = await documents.get(project.userId, "preferences", id);
  if (existing?.projectId === project.id && existing.payload?.recordType === "native-upload-attempt") return;
  try {
    await documents.put(project.userId, "preferences", id,
      { recordType: "native-upload-attempt", state: "attempted" }, { expectedRevision: 0, projectId: project.id });
  } catch (error) {
    if (error?.code !== "product_revision_conflict") throw error;
    const concurrent = await documents.get(project.userId, "preferences", id);
    if (concurrent?.projectId !== project.id || concurrent.payload?.recordType !== "native-upload-attempt") throw error;
  }
}
