/** Ingest only authenticated user-origin material. Clinical interpretation stays
 * with the agent; original bytes, pseudonyms and source permission stay in the plane. */
import { createHash } from 'node:crypto';
import { canonicalJson, sourceOriginOf } from '@evimed/domain';
import { HttpError } from './security.mjs';
const invalid = () => new HttpError(400,'vcr_patient_context_invalid','Select an original user message or an owned uploaded source.');
const digest = text => createHash('sha256').update(text).digest('hex');
export function createVcrPatientContext({ store, dataStore, dataPlane, documents, transcript, isHumanMessage, sources = null }) {
  const intake = async (study, input, origin) => {
    if (!dataPlane || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['messageSeq','sourceId'].includes(key))
      || input.messageSeq != null && !Number.isSafeInteger(input.messageSeq)
      || input.messageSeq != null && input.sourceId != null) throw invalid();
    let text, provenance;
    if (input.sourceId != null) {
      if (typeof input.sourceId !== 'string' || !sources) throw invalid();
      const source = await sources.get(origin.userId,input.sourceId);
      if (source.userId !== origin.userId || source.projectId !== origin.projectId || source.payload?.connector?.type !== 'upload'
        || !source.payload?.paths?.length || source.payload.paths.some(path => sourceOriginOf({connectorType:source.payload.connector.type,path}) !== 'upload')) throw invalid();
      const capture = await sources.loadCapture(origin.userId,source);
      if (!capture?.input?.text) throw invalid();
      text = capture.input.text;
      provenance = { kind:'owned_upload',sourceId:source.id,generation:source.payload.generation,sha256:source.payload.analysis.textSha256 };
    } else {
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
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text)>400*1024) throw invalid();
    const identity = digest(canonicalJson(provenance));
    const name = '对话病例';
    // One native source request is one protected source even under repeated tool calls.
    return store.transaction(async client => store.database.withTransactionClient(client,async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`vcr-patient-context:${study.id}:${identity}`]);
      const prior=(await dataStore.listSourceFilesForStudy(study.id)).find(file=>file.role==='document' && canonicalJson(file.detail?.import ?? null)===canonicalJson(provenance));
      const existing=prior ? await dataStore.sourceInStudy(study.id,prior.sourceId) : null;
      const source = existing ?? await dataPlane.registerSource({userId:origin.userId,studyId:study.id,name,
        allowedUses:['vcr','matching'],valueSource:'extracted',actor:origin.userId});
      const upload = await dataPlane.storeUpload({actor:origin.userId,studyId:study.id,sourceId:source.id,name:'patient-context.txt',role:'document',
        subject:`conversation-case:${identity}`,importedFrom:provenance,stream:(async function*(){yield Buffer.from(text,'utf8');})()});
      const subjectKey = upload.file.detail.subjectKey;
      // The same judged read/projection and recorded quote window used by all patient evidence.
      const material = await documents.subjectDocuments(study,{subjectKey,documentId:upload.file.id});
      return {ok:true,ids:[upload.file.id],issues:material.available===false ? [{field:'material',code:material.code ?? 'vcr_projection_unavailable',message:material.message ?? 'The original was preserved but cannot currently be read by the model.'}] : [],sourceId:source.id,subjectKey,documentId:upload.file.id,material,
        basis:provenance.kind,valueSource:'extracted'};
    }));
  };
  intake.candidates = async (origin, {beforeSeq=undefined,limit=20} = {}) => {
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
    return {candidates,nextBeforeSeq:limited ? candidates.at(-1).messageSeq : page.exhausted === true || !Number.isFinite(oldest) ? null : oldest};
  };
  return intake;
}
