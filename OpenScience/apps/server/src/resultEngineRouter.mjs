import { HttpError } from "./security.mjs";

/** Aggregate R methods remain on the existing VCR engine; Python recipes use
 * the fixed numerical adapter. No generic script engine is introduced. */
export class ResultEngineRouter {
  constructor({ python, vcr = null }) { this.python = python; this.vcr = vcr; }
  select(method) { return ["design.analytic", "comparator.evalue"].includes(method) ? this.vcr : this.python; }
  configured(method) { return this.select(method)?.configured(method) === true; }
  required(scope) {
    const engine = this.select(scope.method);
    if (!engine?.configured(scope.method)) throw new HttpError(503, "result_engine_unavailable", `The calculation engine for ${scope.method} is not deployed in this environment.`);
    return engine;
  }
  capabilities(scope) { return this.required(scope).capabilities(scope); }
  start(scope, recipe, options = {}) { return this.required(scope).start(scope, recipe, options); }
  status(scope, options = {}) { return this.required(scope).status(scope, options); }
  cancel(scope) { return this.required(scope).cancel(scope); }
}
