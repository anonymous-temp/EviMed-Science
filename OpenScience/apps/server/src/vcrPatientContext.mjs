/** Ingest only authenticated user-origin material. Clinical interpretation stays
 * with the agent; original bytes, pseudonyms and source permission stay in the plane.
 *
 * A later message or attachment about the same person joins that person: the model decides it is the same person and says so with `subjectKey`, and nothing asks anyone to confirm. What
 * is added stands as a document of the conversation with its source, and the verdicts that person already has are judged again from it, through the judging job; the earlier verdict
 * stays readable as history. A record that cannot be read now (the parser is off, a scan the deployment cannot read) is a plain answer with the original kept for the next try, never a
 * lost file. */
import { createHash } from 'node:crypto';
import { canonicalJson, segmentSentences, sourceOriginOf, splitNoteParts, vcrSubjectLabel } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { VCR_PATIENT_CONTEXT_MAX_BYTES, VCR_UPLOAD_ORIGINALS_DIR } from './vcrUploadReceipts.mjs';
const invalid = () => new HttpError(400,'vcr_patient_context_invalid','Select an original user message or an owned uploaded source.');
const digest = text => createHash('sha256').update(text).digest('hex');
const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
/** The characters of one stored document of a long record: well inside the plane's byte ceiling for a document whatever the script. */
const DOCUMENT_CHARS = 300_000;
/** What may be tried again by the same call: the original is safe where it is, and the reader may be back. */
const KEPT_FOR_RETRY = Object.freeze(['vcr_document_parser_unavailable', 'vcr_document_parser_failed', 'vcr_document_needs_text', 'vcr_document_converter_unavailable', 'vcr_intake_timeout', 'vcr_intake_failed']);
const KEPT_MESSAGE = Object.freeze({
  vcr_document_parser_unavailable: '这份病历是扫描件或图片，要交给文档解析服务才能读出文字，但本部署的解析服务现在没有接通。原件已保留，解析服务恢复后用同样的参数再写一次即可；其他工作可以继续。',
  vcr_document_parser_failed: '文档解析服务这次没有读出这份病历。原件已保留，稍后用同样的参数再写一次即可；其他工作可以继续。',
  vcr_document_needs_text: '这份病历里读不出文字。原件已保留；可以提供文字版，或稍后再试一次。',
});
export function createVcrPatientContext({ store, dataStore, dataPlane, documents, transcript, isHumanMessage, sources = null, uploadReceipts = null, rejudge = null, subjectKnown = null }) {
  const intake = async (study, input, origin) => {
    if (!dataPlane || !origin || study?.userId !== origin.userId || study.projectId !== origin.projectId
      || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['messageSeq','sourceId','generation','sha256','subjectKey'].includes(key))
      || input.messageSeq != null && !Number.isSafeInteger(input.messageSeq)
      || input.messageSeq != null && input.sourceId != null
      || input.subjectKey != null && (typeof input.subjectKey !== 'string' || !ID.test(input.subjectKey))) throw invalid();
    const { sourceId, generation, sha256, subjectKey = null } = input;
    if (sourceId != null && (typeof sourceId !== 'string' || !ID.test(sourceId))) throw invalid();
    // The person named must be one of this study's, and one who has not withdrawn. That is identity, which is code's; whether it is the same person is the model's.
    if (subjectKey != null && !(await subjectKnown?.(study, subjectKey))) throw new HttpError(404, 'vcr_subject_not_found', 'That subjectKey is not a person of this study; leave it out to start a new patient.');
    let text, provenance, bytes, format = 'txt';
    if (sourceId?.startsWith('upl_')) {
      const original = await uploadReceipts?.readPatientOriginal(origin, { sourceId, generation, sha256 });
      if (!original) throw invalid();
      ({ bytes, provenance, format } = original);
    } else if (sourceId != null) {
      if (!sources || generation != null || sha256 != null) throw invalid();
      const source = await sources.get(origin.userId, sourceId).catch(error => {
        if (error?.code === 'source_not_found') throw invalid();
        throw error;
      });
      if (source?.userId !== origin.userId || source.projectId !== origin.projectId || source.payload?.connector?.type !== 'upload'
        || source.payload.publication?.current === false || !source.payload.paths?.length
        || source.payload.paths.some(path => path.startsWith(`${VCR_UPLOAD_ORIGINALS_DIR}/`)
          || sourceOriginOf({connectorType:source.payload.connector.type,path}) !== 'upload')) throw invalid();
      const capture = await sources.loadCapture(origin.userId,source);
      if (!capture?.input?.text) throw invalid();
      text = capture.input.text;
      provenance = { kind:'owned_upload',sourceId:source.id,generation:source.payload.generation,sha256:source.payload.analysis.textSha256 };
    } else {
      if (generation != null || sha256 != null) throw invalid();
      const page = await transcript(origin, { maxPages:4, ...(input.messageSeq != null ? {beforeSeq:input.messageSeq+1} : {}) });
      if (page?.sessionId !== origin.rootSessionId) throw invalid();
      const messages = page.messages.filter(message => message.role === 'user' && message.source === 'user'
        && (input.messageSeq == null || message.seq === input.messageSeq));
      const eligible = [];
      for (const message of messages) if (await isHumanMessage(origin,message)) eligible.push(message);
      const message = eligible.at(-1);
      if (!message || !Number.isSafeInteger(message.seq)) throw invalid();
      text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      provenance = { kind:'authenticated_user_message',sessionId:origin.rootSessionId,messageSeq:message.seq,sha256:digest(text) };
    }
    if (!bytes) {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > VCR_PATIENT_CONTEXT_MAX_BYTES) throw invalid();
      bytes = Buffer.from(text, 'utf8');
    }
    // A text record longer than one stored document is several documents of one person, cut where it divides itself: nothing of it is refused for its length.
    const decoded = ['txt', 'md'].includes(format) ? bytes.toString('utf8') : null;
    const pieces = decoded && decoded.length > DOCUMENT_CHARS
      ? splitNoteParts([{ text: decoded, sentences: segmentSentences(decoded) }], DOCUMENT_CHARS).map(part => Buffer.from(part.text, 'utf8')) : [bytes];
    const identity = digest(canonicalJson(provenance));
    const name = '对话病例';
    let stored;
    try {
      // One native source request is one protected source even under repeated tool calls.
      stored = await store.transaction(async client => store.database.withTransactionClient(client,async () => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`vcr-patient-context:${study.id}:${identity}`]);
        const prior=(await dataStore.listSourceFilesForStudy(study.id)).find(file=>file.role==='document' && canonicalJson(file.detail?.import ?? null)===canonicalJson(provenance));
        const existing=prior ? await dataStore.sourceInStudy(study.id,prior.sourceId) : null;
        const source = existing ?? await dataPlane.registerSource({userId:origin.userId,studyId:study.id,name,
          allowedUses:['vcr','matching'],valueSource:'extracted',actor:origin.userId});
        const uploads = [];
        for (const [at, piece] of pieces.entries()) {
          uploads.push(await dataPlane.storeUpload({actor:origin.userId,studyId:study.id,sourceId:source.id,name:`patient-context.${format}`,role:'document',
            ...(subjectKey ? {subjectKey} : {subject:`conversation-case:${identity}`}),importedFrom:at ? {...provenance,part:at} : provenance,stream:(async function*(){yield piece;})()}));
        }
        return { source, uploads };
      }));
    } catch (error) {
      if (!KEPT_FOR_RETRY.includes(error?.code) || !sourceId?.startsWith('upl_')) throw error;
      // The reader failed and the original is where it was. That is an answer, not a failure of the conversation: a later call with the same handle reads it.
      return { ok: false, ids: [], issues: [{ field: 'document', code: error.code, message: KEPT_MESSAGE[error.code] ?? '这份病历这次没有读出来。原件已保留，稍后用同样的参数再写一次即可；其他工作可以继续。' }],
        kept: true, retry: { what: 'patient_context', data: { sourceId, generation, sha256, ...(subjectKey ? { subjectKey } : {}) } }, basis: provenance.kind };
    }
    const { source, uploads } = stored;
    const upload = uploads[0];
    const key = upload.file.detail.subjectKey;
    // The same judged read/projection and recorded quote window used by all patient evidence.
    const material = await documents.subjectDocuments(study,{subjectKey:key,documentId:upload.file.id});
    // Only what is new to a person they already had changes what was concluded; a repeat of the same call finds the document and starts nothing.
    const joined = subjectKey && uploads.some(item => item.created);
    const rejudging = joined && rejudge ? await rejudge(study, { subjectKey, documentId: upload.file.id, reason: 'follow_up', actor: origin.userId }).catch(() => null) : null;
    return {ok:true,ids:uploads.map(item => item.file.id),issues:material.available===false ? [{field:'material',code:material.code ?? 'vcr_projection_unavailable',message:material.message ?? 'The original was preserved but cannot currently be read by the model.'}] : [],sourceId:source.id,subjectKey:key,subjectLabel:vcrSubjectLabel(key),documentId:upload.file.id,material,
      ...(uploads.length > 1 ? {documents:uploads.length} : {}),...(upload.file.detail.extraction?.reader ? {readBy:upload.file.detail.extraction.reader} : {}),
      ...(rejudging ? {rejudging:{jobIds:rejudging.jobs.map(job => job.jobId),statement:rejudging.statement}} : {}),
      basis:provenance.kind,valueSource:'extracted'};
  };
  intake.candidates = async (origin, {beforeSeq=undefined,limit=20,cursor=undefined,knowledgeCursor=undefined} = {}, study = null) => {
    if(beforeSeq!=null && !Number.isSafeInteger(beforeSeq) || !Number.isSafeInteger(limit) || limit<1 || limit>20) throw invalid();
    const page = await transcript(origin,{maxPages:4,...(beforeSeq == null ? {} : {beforeSeq})});
    if (page?.sessionId !== origin.rootSessionId) throw invalid();
    const candidates=[];
    let limited=false;
    for (const message of [...page.messages].reverse()) {
      if (message.role !== 'user' || message.source !== 'user' || !Number.isSafeInteger(message.seq) || !await isHumanMessage(origin,message)) continue;
      const text=message.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n');
      if (!text.trim()) continue;
      candidates.push({messageSeq:message.seq,turn:message.turn ?? null,preview:[...text].slice(0,240).join(''),sha256:digest(text)});
      if (candidates.length >= limit) {limited=true;break;}
    }
    const oldest=page.messages.reduce((minimum,message)=>Number.isSafeInteger(message.seq) ? Math.min(minimum,message.seq) : minimum,Infinity);
    const uploads = await uploadReceipts?.patientCandidates(origin, { limit, cursor });
    // The project's knowledge-base documents, so the model can find one: a document with text is a patient record by naming its sourceId.
    const library = sources ? await sources.list(origin.userId, { projectId: origin.projectId, limit, cursor: knowledgeCursor ?? null }).catch(() => null) : null;
    const knowledgeDocuments = (library?.items ?? []).filter(source => source.payload?.connector?.type === 'upload' && source.payload.publication?.current !== false && source.payload.analysis?.textSha256
      && source.payload.paths?.length && !source.payload.paths.some(item => item.startsWith(`${VCR_UPLOAD_ORIGINALS_DIR}/`)))
      .map(source => ({ sourceId: source.id, name: String(source.payload.paths[0]).split('/').pop() }));
    // Who this study already has, so a later message can join the right person.
    /** @type {Map<string, { subjectKey: string, subjectLabel: string, documents: number, lastAt: string | null }>} */
    const patients = new Map();
    for (const file of study?.id ? await dataStore.listSourceFilesForStudy(study.id) : []) {
      const key = file.detail?.subjectKey;
      if (file.role !== 'document' || !key || file.erasedAt) continue;
      const entry = patients.get(key) ?? { subjectKey: key, subjectLabel: vcrSubjectLabel(key), documents: 0, lastAt: null };
      entry.documents += 1; entry.lastAt = String(file.createdAt ?? entry.lastAt ?? '') || null;
      patients.set(key, entry);
    }
    return { candidates, nextBeforeSeq:limited ? candidates.at(-1).messageSeq : page.exhausted === true || !Number.isFinite(oldest) ? null : oldest,
      ...(uploads ? { uploads: uploads.uploads, ...(uploads.nextCursor ? { nextUploadRead: { what: 'patient_context', filter: { limit, cursor: uploads.nextCursor } } } : {}),
        ...(uploads.uploads.length ? { uploadWrite: { what: 'patient_context', dataFields: ['sourceId', 'generation', 'sha256'] } } : {}) } : {}),
      ...(knowledgeDocuments.length ? { knowledgeDocuments, knowledgeWrite: { what: 'patient_context', dataFields: ['sourceId'] } } : {}),
      ...(library?.nextCursor ? { nextKnowledgeRead: { what: 'patient_context', filter: { limit, knowledgeCursor: library.nextCursor } } } : {}),
      ...(patients.size ? { patients: [...patients.values()].slice(-50), followUpWrite: { what: 'patient_context', dataFields: ['messageSeq or sourceId', 'subjectKey'] } } : {}) };
  };
  return intake;
}
