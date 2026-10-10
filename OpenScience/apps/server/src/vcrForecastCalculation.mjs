/** Statistical work runs off the HTTP event loop. This is deterministic code,
 * not a locally deployed model. Patient inputs never enter the DSH workspace. */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { evaluateForecast, compareForecasts, evaluateTrialBenchmark } from '@evimed/domain';
import { HttpError } from './security.mjs';

if (!isMainThread) {
  const {method,args} = workerData;
  const value = method === 'forecast.evaluate' ? evaluateForecast(args[0],args[1],args[2],args[3])
    : method === 'forecast.compare' ? compareForecasts(args[0],args[1],args[2])
      : method === 'forecast.trial_benchmark' ? evaluateTrialBenchmark(args[0],args[1]) : null;
  parentPort?.postMessage(value);
}

/** @param {string} method @param {any[]} args
 * @param {{timeoutMs?:number,isCanceled?:()=>Promise<boolean>}} [options] */
export async function runForecastCalculation(method,args,{timeoutMs = 120_000,isCanceled = async()=>false} = {}) {
  if (await isCanceled()) throw new HttpError(409,'vcr_forecast_unavailable','This calculation was canceled.');
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL(import.meta.url),{workerData:{method,args},resourceLimits:{maxOldGenerationSizeMb:512}});
    let settled = false;
    let pendingCheck = Promise.resolve();
    let polling = false;
    /** @param {unknown} error @param {any} [value] */
    const finish = (error,value) => {
      if (settled) return; settled = true;
      clearTimeout(deadline);clearInterval(poll);
      void Promise.allSettled([worker.terminate(),pendingCheck]).then(() => {if (error) reject(error);else resolve(value);});
    };
    const deadline = setTimeout(() => finish(new HttpError(408,'vcr_forecast_unavailable','This calculation reached its time budget; other results remain available.')),timeoutMs);
    const poll = setInterval(() => {
      if (polling || settled) return;polling = true;
      pendingCheck = (async () => {
        try {if (await isCanceled()) finish(new HttpError(409,'vcr_forecast_unavailable','This calculation was canceled.'));}
        catch {finish(new HttpError(409,'vcr_forecast_unavailable','This calculation could not retain its job lease.'));}
        finally {polling = false;}
      })();
    },250);
    worker.once('message',value => finish(null,value));
    worker.once('error',() => finish(new HttpError(422,'vcr_forecast_unavailable','This calculation did not complete; its inputs are preserved.')));
    worker.once('exit',() => {if (!settled) finish(new HttpError(422,'vcr_forecast_unavailable','This calculation ended without a result.'));});
  });
}
