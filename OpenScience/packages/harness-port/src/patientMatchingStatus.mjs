/** Fixed first-party, read-only proof of the enabled matching bundle's actual native registrations. */
import { loadHarnessModule } from '../index.mjs'

/** Register fixed status and task cancellation Remote methods. Inventory is trusted code, never wire input.
 * No patient data, tool execution, provider request, profile mutation or generic plugin inspection is exposed.
 * @param {any} ctx
 * @param {{tools:readonly string[],cancel?:(taskId:string)=>boolean|Promise<boolean>}} options
 */
export async function registerPatientMatchingStatus(ctx, { tools, cancel }) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 32 || new Set(tools).size !== tools.length
    || tools.some(name => typeof name !== 'string' || !/^match_[a-z]+$/.test(name))) throw new Error('patient_matching_probe_config_invalid')
  const inventory = Object.freeze([...tools])
  const { TypertRemoteService, Remote } = await loadHarnessModule('@deepseek-ai/dsh-typert-protocol')
  /** @type {((this:any)=>void)[]} */ const initializers = []
  class PatientMatchingStatus extends TypertRemoteService {
    constructor() { super(ctx, 'patientMatching'); for (const initialize of initializers) initialize.call(this) }
    /** @param {string} taskId */
    async cancel(taskId) {
      if (typeof taskId !== 'string' || !/^[A-Za-z0-9@][A-Za-z0-9@._:/+-]{0,199}$/.test(taskId)) throw new Error('patient_matching_task_invalid')
      return { cancelled: typeof cancel === 'function' && await cancel(taskId) === true }
    }
    /** @param {AbortSignal} [signal] */
    async status(signal) {
      const cancellation = signal ?? AbortSignal.timeout(10000)
      cancellation.throwIfAborted()
      const definitions = inventory.map(name => ctx.tools.get(name))
      const summaries = await ctx.skills.list({ signal: cancellation })
      const definition = summaries.some((/** @type {any} */ skill) => skill.name === 'patient-matching')
        ? await ctx.skills.get('patient-matching', { signal: cancellation }) : undefined
      cancellation.throwIfAborted()
      const registered = inventory.filter((name, index) => definitions[index]?.name === name && ctx.tools.get(name) === definitions[index])
      const skill = definition?.name === 'patient-matching' && typeof definition.content === 'string' && definition.content.trim() ? 'patient-matching' : null
      return { enabled: registered.length === inventory.length && skill !== null, tools: registered, skill }
    }
  }
  for (const method of ['status', 'cancel']) Remote(PatientMatchingStatus.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer: (/** @type {(this:any)=>void} */ initialize) => initializers.push(initialize),
  })
  return new PatientMatchingStatus()
}
