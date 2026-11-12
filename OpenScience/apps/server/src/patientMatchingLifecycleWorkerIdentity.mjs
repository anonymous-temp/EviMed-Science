/** Read-only inspection of the single deployment-configured matching worker, never a runtime-supplied name. */
import { spawnSync } from 'node:child_process';
import { HttpError } from './security.mjs';
const unavailable = () => new HttpError(503, 'patient_matching_worker_unavailable', 'The isolated matching worker is unavailable.');
/** @param {any} config @param {any} observed */
export function patientMatchingWorkerIdentity(config, observed) {
  const container = String(config.patientMatchingWorkerContainer ?? ''), digest = String(config.patientMatchingWorkerImageDigest ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container) || !/^sha256:[a-f0-9]{64}$/.test(digest)
    || observed?.Name !== `/${container}` || observed.Image !== digest || observed.State?.Running !== true
    || observed.HostConfig?.NetworkMode !== 'none' || observed.HostConfig.ReadonlyRootfs !== true
    || !observed.HostConfig.CapDrop?.some(value => String(value).toUpperCase() === 'ALL')
    || !observed.HostConfig.SecurityOpt?.some(value => /^no-new-privileges(?::true|=true)?$/.test(String(value)))) throw unavailable();
  return { imageId: observed.Image, running: true, containerId: observed.Id };
}
/** @param {any} config */
export function inspectPatientMatchingWorker(config) {
  const container = String(config.patientMatchingWorkerContainer ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw unavailable();
  const inspected = spawnSync(config.runtimeContainerBin, ['container', 'inspect', '--format', '{{json .}}', container], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (inspected.status !== 0) throw unavailable();
  let observed; try { observed = JSON.parse(inspected.stdout); } catch { throw unavailable(); }
  return patientMatchingWorkerIdentity(config, observed);
}
