import { HttpError } from './security.mjs';
import { productId } from './productPersistence.mjs';

/** Closed request metadata: no credentials, commands or caller-selected authority. @param {any} value @param {string[]} keys @param {string[]} [required] */
export function extensionRequestObject(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item,'value') || !item.enumerable)
    || required.some(key => !Object.hasOwn(value,key))) throw new HttpError(400,'extension_contract_invalid','Invalid extension request fields.');
  return value;
}
/** Metadata IDs never select host paths or arbitrary URLs. @param {any} value */
export function extensionIdentifier(value) {
  const id = productId(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(id)) throw new HttpError(400,'extension_contract_invalid','Invalid extension identifier.');
  return id;
}
/** @param {any} values @param {number} [max] */
export function extensionArray(values,max=128) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values)!==Array.prototype || values.length>max
    || Reflect.ownKeys(values).length!==values.length+1 || Object.entries(Object.getOwnPropertyDescriptors(values)).some(([key,item])=>key!=='length'&&(!/^\d+$/.test(key)||!Object.hasOwn(item,'value')||!item.enumerable))) {
    throw new HttpError(400,'extension_contract_invalid','Expected a bounded dense extension list.');
  }
  return values;
}

/** The injected judges are trusted server adapters, never request fields or cached package declarations. */
export class ExtensionAccess {
  /** @param {{store?:any,projectAccess?:any,connectionAccess?:any}} options */
  constructor({store=null,projectAccess=null,connectionAccess=null}={}) { this.store=store;this.projectAccess=projectAccess;this.connectionAccess=connectionAccess; }
  /** Hold the current account generation during an atomic write. @param {any} user @param {any} client */
  async account(user,client) {
    if(!user?.id)throw new HttpError(401,'unauthorized','Authentication is required.');
    const result=await client.query('SELECT created_at::text AS "createdAt" FROM evimed_control.users WHERE id=$1 AND ($2::timestamptz IS NULL OR created_at=$2::timestamptz) FOR SHARE',
      [extensionIdentifier(user.id),user.accountCreatedAt??null]);
    if(!result.rows[0])throw new HttpError(401,'unauthorized','This account is unavailable.');
    return result.rows[0].createdAt;
  }
  /** Resolve membership afresh. Shared judges must retain their permission row lock on the supplied transaction. @param {any} user @param {string} projectId @param {{manage?:boolean,client?:any}} options */
  async project(user,projectId,{manage=false,client=null}={}) {
    const id=extensionIdentifier(projectId);let resolved;
    try {
      if(this.projectAccess)resolved=await this.projectAccess(user,id,{manage,client});
      else if(this.store) {
        // Store.requireProject also opens a transaction. Borrow the caller's
        // checked client so scope checks remain atomic and work with pool one.
        const resolve = () => this.store.requireProject(user,id);
        const project = client && this.store.database?.withTransactionClient
          ? await this.store.database.withTransactionClient(client, resolve) : await resolve();
        resolved={project,role:project.userId===user.id?'owner':null};
      }
    } catch(error) { if(error?.status===404)resolved=null;else throw error; }
    if(!resolved?.project || resolved.project.id!==id || !['owner','editor','viewer'].includes(resolved.role)
      || (manage&&!['owner','editor'].includes(resolved.role)))throw new HttpError(404,'project_not_found','Project not found.');
    extensionIdentifier(resolved.project.userId);
    if(client) {
      const present=await client.query('SELECT id,created_at::text AS "projectCreatedAt" FROM evimed_control.projects WHERE user_id=$1 AND id=$2 FOR SHARE',[resolved.project.userId,id]);
      if(!present.rows[0])throw new HttpError(404,'project_not_found','Project not found.');
      return { ...resolved.project, projectCreatedAt: present.rows[0].projectCreatedAt };
    }
    return resolved.project;
  }
  /** These references resolve only in the invoking actor's connection boundary. @param {any} user @param {any} values @param {{client?:any,project?:any,entry?:any}} options */
  async connections(user,values,{client=null,project=null,entry=null}={}) {
    const refs=extensionArray(values,64).map(extensionIdentifier);
    if(new Set(refs).size!==refs.length)throw new HttpError(400,'extension_contract_invalid','Duplicate connection references.');
    for(const ref of refs)if(!this.connectionAccess || !await this.connectionAccess(user,ref,{client,project,entry}))throw new HttpError(403,'extension_access_denied','This connection is not authorized for this operation.');
    return refs;
  }
}
