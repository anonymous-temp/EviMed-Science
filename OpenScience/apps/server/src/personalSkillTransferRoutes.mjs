import { HttpError, readBody, readJson, sendJson } from './security.mjs';
import { PERSONAL_SKILL_TRANSFER_MAX_BYTES, exportPersonalSkills } from './personalSkillTransfer.mjs';

/** Authenticated authored-data transfer; no account/runtime authority import.
 * @param {{store:any,service:any,skills:any,artifacts:any,maxJsonBytes:number}} dependencies */
export function createPersonalSkillTransferRoutes({ store, service, skills, artifacts, maxJsonBytes }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://evimed.local');
    const action = /^\/api\/skills\/transfers\/(uploads|preview|confirm|pending)$/.exec(url.pathname);
    const portable = /^\/api\/skills\/([^/]+)\/portable$/.exec(url.pathname);
    if (!action && !portable) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service || !skills || !artifacts) throw new HttpError(503, 'product_state_unavailable', 'Authored skill transfer is unavailable.');
    res.setHeader('Cache-Control', 'no-store');
    if (action?.[1] === 'pending' && req.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => key !== 'cursor')) throw new HttpError(400, 'extension_contract_invalid', 'Invalid transfer recovery request.');
      sendJson(res, 200, { data: await service.pending(user, { cursor: url.searchParams.get('cursor') }) }); return true;
    }
    if (portable && req.method === 'GET') {
      if ([...url.searchParams].length) throw new HttpError(400, 'extension_contract_invalid', 'Invalid portable export request.');
      let id; try { id = decodeURIComponent(portable[1]); } catch { throw new HttpError(400, 'extension_contract_invalid', 'Invalid skill reference.'); }
      const bytes = await exportPersonalSkills({ skills, artifacts }, user, [id]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length), 'Content-Disposition': 'attachment; filename="evimed-personal-skill.json"' });
      res.end(bytes); return true;
    }
    if (!action || action[1] === 'pending' || req.method !== 'POST') throw new HttpError(404, 'not_found', 'Transfer route not found.');
    let data;
    if (action[1] === 'uploads') {
      if (req.headers['content-type'] !== 'application/octet-stream' || [...url.searchParams.keys()].some(key => key !== 'format')
        || !['portable', 'account'].includes(url.searchParams.get('format'))) throw new HttpError(400, 'extension_contract_invalid', 'Invalid authored transfer upload.');
      data = await service.upload(user, await readBody(req, PERSONAL_SKILL_TRANSFER_MAX_BYTES), url.searchParams.get('format'));
    } else {
      if ([...url.searchParams].length) throw new HttpError(400, 'extension_contract_invalid', 'Invalid authored transfer request.');
      data = await service[action[1]](user, await readJson(req, maxJsonBytes));
    }
    sendJson(res, 200, { data }); return true;
  };
}
