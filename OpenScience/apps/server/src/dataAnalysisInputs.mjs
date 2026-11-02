/** Bounded byte ingestion. Source credentials belong to deployment configuration, never request fields. */
import { readFile } from 'node:fs/promises';
import { HttpError } from './security.mjs';
import { validatedWebUrl, nodeWebTransport, headerValue } from './webReadNetwork.mjs';

/** @param {any} body @param {string[]} allowed */
export function analysisFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw new HttpError(400, 'analysis_payload_invalid', 'The request has unsupported fields or is not an object.');
  }
  return body;
}
/** @param {any} value @param {number} max */
export function analysisString(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw new HttpError(400, 'analysis_payload_invalid', 'A required string is empty or too long.');
  return value.trim();
}
/** @param {any} value */
export function analysisFilename(value) {
  const name = analysisString(value, 160);
  if (name.startsWith('.') || /[/\\]/.test(name) || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || name.endsWith('.')) throw new HttpError(400, 'analysis_filename_invalid', 'Use a filename without directories, control characters or a leading dot.');
  return name;
}
/** @param {{url:string,authorization?:string,maxBytes:number,timeoutMs?:number,transport?:import('./webReadNetwork.mjs').WebTransport}} options */
export async function fetchAnalysisInput(options) {
  try{return await fetchBytes(options);}
  catch(error){
    if(error instanceof HttpError)throw error;
    if(error?.name==='TimeoutError'||error?.name==='AbortError')throw new HttpError(504,'analysis_source_timeout','The source did not answer within the deadline.');
    if(typeof error?.status==='number'&&typeof error?.code==='string')throw new HttpError(error.status,error.code,error.message);
    throw new HttpError(502,'analysis_source_failed','The data source could not be read.');
  }
}
/** @param {{url:string,authorization?:string,maxBytes:number,timeoutMs?:number,transport?:import('./webReadNetwork.mjs').WebTransport}} options */
async function fetchBytes({url, authorization, maxBytes, timeoutMs = 30_000, transport = nodeWebTransport()}) {
  let target = validatedWebUrl(url);
  const origin = target.origin, signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= 4; hop++) {
    if (target.protocol !== 'https:') throw new HttpError(400, 'analysis_url_invalid', 'Data inputs require a public HTTPS URL.');
    signal.throwIfAborted();
    const response = await transport({url:target,headers:{accept:'application/octet-stream',...(authorization && target.origin === origin ? {authorization} : {})},signal,maxBytes});
    if ([301,302,303,307,308].includes(response.status)) {
      if (hop === 4) throw new HttpError(502, 'analysis_redirect_limit', 'The source redirected too many times.');
      const location = headerValue(response.headers, 'location');
      if (!location) throw new HttpError(502, 'analysis_source_failed', 'The source redirect has no destination.');
      target = validatedWebUrl(new URL(location,target));
      // Once a redirect leaves the configured origin the credential is discarded, even if it returns.
      if (target.origin !== origin) authorization = undefined;
      continue;
    }
    if (response.status !== 200) throw new HttpError(502, 'analysis_source_failed', 'The data source did not return a complete file.');
    if (!response.body.length || response.body.length > maxBytes) throw new HttpError(413, 'analysis_input_limit', 'The input is empty or exceeds the byte limit.');
    return response.body;
  }
  throw new HttpError(502, 'analysis_source_failed', 'The data source could not be read.');
}
/** @param {any} user @param {any} body @param {any} config @param {any} [transport] */
export async function analysisInputBytes(user, body, config, transport) {
  analysisFields(body,['filename','base64','url','sourceId']);
  const filename = analysisFilename(body.filename);
  if (['base64','url','sourceId'].filter(key => body[key] !== undefined).length !== 1) throw new HttpError(400, 'analysis_payload_invalid', 'Choose exactly one of base64, url or sourceId.');
  const maxBytes = config.dataAnalysisMaxInputBytes;
  if (body.base64 !== undefined) {
    if (typeof body.base64 !== 'string' || body.base64.length > Math.ceil(maxBytes / 3) * 4 || body.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body.base64)) throw new HttpError(400, 'analysis_base64_invalid', 'The input must use canonical padded base64.');
    const buffer = Buffer.from(body.base64,'base64');
    if(buffer.toString('base64')!==body.base64)throw new HttpError(400,'analysis_base64_invalid','The input must use canonical padded base64.');
    if (!buffer.length || buffer.length > maxBytes) throw new HttpError(413, 'analysis_input_limit', 'The input is empty or exceeds the byte limit.');
    return {filename,buffer,provenance:{kind:'upload'}};
  }
  let url = body.url, authorization;
  if (body.sourceId !== undefined) {
    const id = analysisString(body.sourceId,80);
    // The file contains exact URLs and explicit account grants. No caller-supplied query or headers are merged.
    let sources;
    try { sources = JSON.parse(await readFile(config.dataAnalysisSourcesFile,'utf8')); }
    catch { throw new HttpError(503,'analysis_sources_unavailable','Configured data sources are unavailable.'); }
    const source = sources[id];
    if (!source || !Array.isArray(source.accountIds) || !source.accountIds.includes(user.id)) throw new HttpError(403,'analysis_source_forbidden','This account has no grant for that source.');
    url = source.url;
    if (source.credentialFile) {
      try { authorization = (await readFile(source.credentialFile,'utf8')).trim(); }
      catch { throw new HttpError(503,'analysis_source_credentials_unavailable','The configured source credential is unavailable.'); }
      if (!authorization || authorization.length > 8192 || /[\r\n]/.test(authorization)) throw new HttpError(503,'analysis_source_credentials_unavailable','The configured source credential is invalid.');
    }
  }
  const requested=analysisString(url,2048);
  const buffer=await fetchAnalysisInput({url:requested,authorization,maxBytes,timeoutMs:config.dataAnalysisFetchTimeoutMs,transport});
  const parsed=new URL(requested);
  const provenance=body.sourceId!==undefined?{kind:'configured-source',sourceId:analysisString(body.sourceId,80)}:{kind:'url',origin:parsed.origin,pathname:parsed.pathname};
  return {filename,buffer,provenance};
}
