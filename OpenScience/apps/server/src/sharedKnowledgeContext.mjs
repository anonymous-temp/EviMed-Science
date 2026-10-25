import { createHash } from "node:crypto";
import { projectSourceManifestRecord } from "./sourceService.mjs";
import { knowledgeDigest, knowledgePolicyStamp, knowledgeSourceSetDigest, readKnowledgeSourceInputs, readSelectedKnowledgeGeneration } from "./knowledgeGeneration.mjs";
import { HttpError } from "./security.mjs";

const denied = () => new HttpError(403, "knowledge_scope_denied", "The project knowledge context is unavailable or changed.");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** One owner/control-project floor for background jobs and both KB gateways.
 * Views are operation-scoped; no positive source/policy cache survives a call.
 * Session association is an injected server proof, never a browser assertion.
 * @param {{contextPolicies:any,store:any,sources:any,documents:any,resources:any,sourceSync?:any,sourceScope?:any,proveSession?:any,compileExecutionFor?:any}} dependencies */
export function createSharedKnowledgeContext({ contextPolicies, store, sources, documents, resources, sourceScope = null, proveSession = null, compileExecutionFor = null }) {
  async function forProject(requested) {
    const owner = await store.userById(requested?.userId);
    if (!owner) throw denied();
    const project = await store.requireProject(owner, requested?.id);
    if (project.userId !== requested.userId || project.id !== requested.id) throw denied();
    const resolved = await contextPolicies.forProject(project);
    if (resolved?.kind === "owned") return resolved;
    const stamp = knowledgePolicyStamp(resolved);
    if (stamp.ownerId !== project.userId || stamp.controlProjectId !== project.id) throw denied();
    const inputs = await readKnowledgeSourceInputs({ documents, sources, ownerId: owner.id, projectId: project.id });
    const sourceSetDigest = knowledgeSourceSetDigest(stamp, inputs);
    const selected = await readSelectedKnowledgeGeneration({ documents, sources, project, policy: stamp, currentInputs: inputs, compileExecutionFor });
    async function current() {
      const fresh = knowledgePolicyStamp(await contextPolicies.forProject(project));
      if (fresh.digest !== stamp.digest) throw denied();
      const now = await readKnowledgeSourceInputs({ documents, sources, ownerId: owner.id, projectId: project.id });
      if (knowledgeSourceSetDigest(fresh, now) !== sourceSetDigest) throw denied();
      const after = await readSelectedKnowledgeGeneration({ documents, sources, project, policy: fresh, currentInputs: now, compileExecutionFor });
      if (knowledgeDigest(after?.receipt ?? null) !== knowledgeDigest(selected?.receipt ?? null)) throw denied();
    }
    const original = new Map(inputs.map(input => [input.receipt.sourceId, input]));
    const leaves = new Map();
    for (const input of inputs) {
      const uri = resources.sourceUri(owner.id, project.id, input.receipt.sourceId);
      leaves.set(uri, { uri, size: Buffer.byteLength(input.text), sha256: input.receipt.renditionSha256,
        sourceId: input.receipt.sourceId, title: projectSourceManifestRecord(input.source).display.title });
    }
    for (const output of selected?.outputs ?? []) leaves.set(output.uri, { uri: output.uri, size: output.bytes, sha256: output.engineBytesSha256 });
    const roots = { sources: resources.roots(owner.id, project.id).sources, wiki: selected?.receipt.roots.wiki ?? null, kg: selected?.receipt.roots.kg ?? null };
    const directories = new Set(Object.values(roots).filter(Boolean));
    for (const uri of leaves.keys()) {
      const root = Object.values(roots).find(base => base && uri.startsWith(`${base}/`));
      if (!root) throw denied();
      let parent = uri.slice(0, uri.lastIndexOf("/"));
      while (parent.length >= root.length) { directories.add(parent); parent = parent.slice(0, parent.lastIndexOf("/")); }
    }
    const authorized = (userId, uri) => userId === owner.id && typeof uri === "string" && (leaves.has(uri) || directories.has(uri));
    async function bytes(userId, uri) {
      const leaf = leaves.get(uri);
      if (userId !== owner.id || !leaf) throw denied();
      const value = await resources.download(owner.id, uri);
      if (!Buffer.isBuffer(value) || hash(value) !== leaf.sha256) throw new HttpError(409, "knowledge_resource_changed", "The knowledge resource bytes no longer match the current receipt.");
      return value;
    }
    const entry = uri => ({ uri, isDir: directories.has(uri), size: leaves.get(uri)?.size ?? 0, abstract: "", modTime: null });
    const permittedResources = {
      roots: () => roots,
      inScope: (userId, projectId, uri) => projectId === project.id && authorized(userId, uri),
      listAll: async (userId, uri) => {
        if (!authorized(userId, uri)) throw denied();
        return [...directories, ...leaves.keys()].filter(value => value.startsWith(`${uri}/`) && !value.slice(uri.length + 1).includes("/"))
          .sort().map(entry);
      },
      tree: async (userId, uri) => {
        if (!authorized(userId, uri)) throw denied();
        return [...directories, ...leaves.keys()].filter(value => value.startsWith(`${uri}/`)).sort()
          .map(value => ({ ...entry(value), relPath: value.slice(uri.length + 1) }));
      },
      stat: async (userId, uri) => authorized(userId, uri) ? entry(uri) : null,
      download: bytes,
      read: async (userId, uri, { offset = 0, limit = 0 } = {}) => {
        if (directories.has(uri) && userId === owner.id) return null;
        const text = (await bytes(userId, uri)).toString("utf8");
        return offset || limit ? text.split("\n").slice(offset, limit ? offset + limit : undefined).join("\n") : text;
      },
      grep: async (userId, uri, pattern, { limit = 100, caseInsensitive = false } = {}) => {
        if (!authorized(userId, uri)) throw denied();
        const matches = [], regex = new RegExp(pattern, caseInsensitive ? "i" : "");
        const deadline = Date.now() + 18000;
        const wanted = [...leaves.keys()].filter(value => value === uri || value.startsWith(`${uri}/`));
        for (const value of wanted) {
          if (Date.now() >= deadline) throw new HttpError(503, "knowledge_scan_incomplete", "The permitted knowledge scan could not finish within its bound.");
          const lines = (await bytes(userId, value)).toString("utf8").split("\n");
          for (let index = 0; index < lines.length; index += 1) if (regex.test(lines[index])) {
            matches.push({ uri: value, line: index + 1, content: lines[index] });
            if (matches.length >= limit) return { matches, filesScanned: wanted.indexOf(value) + 1 };
          }
        }
        return { matches, filesScanned: wanted.length };
      },
    };
    return { kind: "geo-project", includeLibrary: false, stamp, project, inputs, sourceSetDigest, selected, resources: permittedResources,
      compileExecutionFor, current,
      lockCurrent: async client => {
        const identity = (await client.query(`SELECT u.created_at::text AS "ownerCreatedAt",p.created_at::text AS "projectCreatedAt"
          FROM evimed_control.users u JOIN evimed_control.projects p ON p.user_id=u.id
          WHERE u.id=$1 AND p.id=$2 AND p.archived_at IS NULL FOR SHARE OF u,p`, [owner.id, project.id])).rows[0];
        if (!identity || identity.ownerCreatedAt !== stamp.ownerCreatedAt || identity.projectCreatedAt !== stamp.projectCreatedAt) throw denied();
        const policy = (await client.query(`SELECT revision,payload FROM evimed_product.documents
          WHERE user_id=$1 AND kind='geo-plan-context' AND id=$2 AND deleted_at IS NULL FOR SHARE`, [owner.id, stamp.referenceId])).rows[0];
        if (!policy || policy.revision !== stamp.revision || knowledgeDigest(policy.payload.namespace) !== knowledgeDigest(resolved.namespace)) throw denied();
        await client.query(`SELECT id FROM evimed_product.documents WHERE user_id=$1 AND project_id=$2
          AND (kind='source' OR kind='knowledge' AND payload->>'recordType'='wiki-page') ORDER BY kind,id FOR SHARE`, [owner.id, project.id]);
      },
      sourcePath: source => {
        const matchedOutput = selected?.outputs.find(output => output.source.sourceId === source.id);
        return matchedOutput ? `knowledge-base/${matchedOutput.tree}/${matchedOutput.mirrorRel}` : source.payload?.outputs?.artifactPath;
      },
      acceptSource: async candidate => {
        const source = candidate?.id ? await sources.get(owner.id, candidate.id) : null;
        return Boolean(source && source.deletedAt == null && source.projectId === project.id
          && (original.get(source.id)?.receipt.sourceRevision === source.revision || selected?.permitsSource(source)));
      },
      sourceScope: async sessionId => {
        if (!sessionId || !proveSession || await proveSession(project, sessionId) !== true) throw denied();
        const scope = sourceScope ? await sourceScope({ userId: owner.id, projectId: project.id }, sessionId) : null;
        if (scope == null) return null;
        if (!Array.isArray(scope)) throw denied();
        const permitted = [];
        for (const id of scope) if (original.has(id) || selected?.outputs.some(output => output.source.sourceId === id)) permitted.push(id);
        return permitted;
      },
      neutral: text => String(text ?? "").replace(/viking:\/\/[^\s"'`()<>[\]]*/g, uri => {
        const matchedInput = inputs.find(input => resources.sourceUri(owner.id, project.id, input.receipt.sourceId) === uri
          || selected && uri === `${selected.receipt.roots.sources}/${input.receipt.sourceId}.md`);
        if (matchedInput) return `source:${matchedInput.receipt.sourceId}`;
        if (!leaves.has(uri)) return "(internal address omitted)";
        const treeName = ["wiki", "kg"].find(name => roots[name] && uri.startsWith(`${roots[name]}/`));
        return treeName ? `${treeName}:${uri.slice(roots[treeName].length + 1)}` : "(internal address omitted)";
      }).replace(/\b(src_[a-f0-9]{32})\b/g, id => original.has(id) || selected?.outputs.some(output => output.source.sourceId === id) ? id : "(unavailable document)"),
    };
  }
  return { forProject, forWorkload: identity => forProject({ userId: identity?.userId, id: identity?.projectId }) };
}
