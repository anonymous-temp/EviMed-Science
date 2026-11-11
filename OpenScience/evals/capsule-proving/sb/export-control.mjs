// Read-only eval IPC extension: export approved methods' frontmatter values, body and script attachments.
export async function control(app, action, { userId, ids = [] } = {}) {
  if (action !== 'lxSbExport') throw new Error('Unknown SB export action');
  const { ProductDocuments } = await import(`${process.env.OS}/apps/server/src/productStore.mjs`);
  const documents = new ProductDocuments(app.store.database);
  const result = [];
  for (const id of ids) {
    const document = await documents.get(userId, 'method', id);
    result.push({ id, ...document.payload });
  }
  return result;
}
