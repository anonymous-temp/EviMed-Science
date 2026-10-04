import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { HttpError } from "./security.mjs";
import { canonicalJson } from "@evimed/domain";
import { VCR_INTAKE_LONG_KINDS } from "./vcrIntakeLayout.mjs";

// Version 11 adds the standard-format import (FHIR resources, OMOP tables, ADaM
// transport files into the module's own tables) to the intake container of
// version 10: the same fixed operation over a file staged in the data plane, a
// fourth kind, `convert`.
// Version 10 adds the source-material read (a knowledge-base source's PDF as
// its pages' text, a spreadsheet as its cells) to the intake container of
// version 9: the same fixed operation over a staged attempt, a third kind.
// Version 9 adds the two 「虚拟临研」 intake conversions (a record document to
// text, a figure to curve points), each one fixed operation over a staged
// attempt. Version 8 added isolated native skill validation; the version-7
// citation runtime-start shape stays explicitly supported during coordinated
// rollout.
export const RUNTIME_CONTROLLER_PROTOCOL_VERSION = 11;

function controllerError(code, message, status = 503) {
  return new HttpError(status, code, message);
}

function projectReference(project) {
  return {
    userId: project.userId,
    projectId: project.id,
    activeWorkspace: project.activeWorkspace ?? "",
  };
}

async function assertSocketFile(socketPath) {
  if (!path.isAbsolute(socketPath)) {
    throw controllerError("runtime_controller_socket_invalid", "Runtime controller socket path must be absolute.");
  }
  const parent = path.dirname(socketPath);
  const parsed = path.parse(parent);
  const parts = path.relative(parsed.root, parent).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const component = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!component) {
      throw controllerError("runtime_controller_unavailable", "Runtime controller is unavailable.");
    }
    if (component.isSymbolicLink()) {
      throw controllerError("runtime_controller_socket_symlink", "Runtime controller socket path must not contain symbolic links.");
    }
  }
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw controllerError("runtime_controller_unavailable", "Runtime controller is unavailable.");
    }
    throw controllerError("runtime_controller_unavailable", "Runtime controller socket could not be inspected.");
  }
  if (stat.isSymbolicLink()) {
    throw controllerError("runtime_controller_socket_symlink", "Runtime controller socket must not be a symbolic link.");
  }
  if (!stat.isSocket()) {
    throw controllerError("runtime_controller_socket_invalid", "Runtime controller path is not a Unix socket.");
  }
}

function parseResponseBody(buffer) {
  if (!buffer.length) return {};
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid response");
    return parsed;
  } catch {
    throw controllerError("runtime_controller_invalid_response", "Runtime controller returned an invalid response.");
  }
}

export class RuntimeControllerClient {
  constructor(config) {
    this.socketPath = String(config.runtimeControllerSocket ?? "").trim();
    this.timeoutMs = Number(config.runtimeControllerTimeoutMs) || 10_000;
    this.maxJsonBytes = Number(config.maxJsonBytes) || 12 * 1024 * 1024;
    this.vcrIntakeTimeoutMs = (Number(config.vcrIntakeTimeoutMs) || 60_000) * 2 + 15_000;
  }

  async request(method, requestPath, payload = null, options = {}) {
    await assertSocketFile(this.socketPath);
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
    if (body && body.length > this.maxJsonBytes) {
      throw controllerError("runtime_controller_request_too_large", "Runtime controller request is too large.", 413);
    }
    const maxResponseBytes = Number(options.maxResponseBytes) || 64 * 1024;
    const timeoutMs = Number(options.timeoutMs) || this.timeoutMs;
    const signal = options.signal;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      const request = http.request({
        socketPath: this.socketPath,
        path: requestPath,
        method,
        headers: body
          ? {
              "content-type": "application/json",
              "content-length": String(body.length),
            }
          : {},
      });
      const abort = () => {
        const error = signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Runtime controller request aborted.", "AbortError");
        request.destroy(error);
      };
      const timer = setTimeout(() => {
        request.destroy(controllerError("runtime_controller_timeout", "Runtime controller request timed out.", 504));
      }, timeoutMs);
      request.once("error", (error) => {
        if (error instanceof HttpError || error?.name === "AbortError") {
          finish(reject, error);
          return;
        }
        finish(reject, controllerError("runtime_controller_unavailable", "Runtime controller request failed."));
      });
      request.once("response", (response) => {
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxResponseBytes) {
            response.destroy(controllerError("runtime_controller_response_too_large", "Runtime controller response is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", (error) => {
          if (error instanceof HttpError || error?.name === "AbortError") {
            finish(reject, error);
            return;
          }
          finish(reject, controllerError("runtime_controller_unavailable", "Runtime controller response failed."));
        });
        response.once("end", () => {
          try {
            const parsed = parseResponseBody(Buffer.concat(chunks));
            if ((response.statusCode ?? 500) >= 400) {
              const code = typeof parsed.code === "string" ? parsed.code : "runtime_controller_error";
              const message = typeof parsed.error === "string" ? parsed.error : "Runtime controller rejected the request.";
              finish(reject, controllerError(code, message, response.statusCode));
              return;
            }
            finish(resolve, parsed.data ?? parsed);
          } catch (error) {
            finish(reject, error);
          }
        });
      });
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
      if (body) request.end(body);
      else request.end();
      options.onDispatch?.();
    });
  }

  /** @param {any} reference @param {{signal?:AbortSignal}} options */
  renderDocument(reference, { signal } = {}) {
    return this.request("POST", "/v1/document/render", reference, { signal, timeoutMs: 210_000 });
  }

  cancelDocumentRender(reference) {
    return this.request("POST", "/v1/document/cancel", reference);
  }

  /**
   * Convert one staged record document to text, or digitize one staged figure,
   * in a disposable container. The caller reads the output directory itself
   * afterwards. A record is named by the path of its staged file inside the data
   * plane with the SHA-256 and size the script checks it against; a figure by its
   * attempt on the shared data volume and the digest of its request. The
   * deadline here is the controller's own plus a margin for queueing, so the
   * controller's timeout answers before this one gives up.
   * @param {'extract'|'digitize'|'materials'|'convert'} kind
   * @param {{path:string,sha256:string,bytes:number,format?:string}|{attemptId:string,inputDigest:string}} reference
   * @param {{signal?:AbortSignal, timeoutMs?:number}} [options]
   */
  runVcrIntake(kind, reference, { signal, timeoutMs } = {}) {
    // A source document, or a whole export, is read whole: the controller allows it twice a conversion's time.
    return this.request("POST", `/v1/vcr/${kind}`, reference, { signal, timeoutMs: timeoutMs ?? this.vcrIntakeTimeoutMs * (VCR_INTAKE_LONG_KINDS.includes(kind) ? 2 : 1) });
  }

  /** Fixed owned content reference; the controller resolves every filesystem path.
   * @param {{ownerHash:string,kind:'imports'|'packages',contentId:string,expectedName:string|null}} reference
   * @param {{signal?:AbortSignal}} [options] */
  async validatePersonalSkill(reference, { signal } = {}) {
    let dispatched = false;
    try {
      return await this.request("POST", "/v1/skills/validate", reference,
        // Native stdout retains its 512 KiB cap; this bounded headroom covers
        // the controller's JSON data envelope around a valid near-limit result.
        { signal, timeoutMs: 60000, maxResponseBytes: 512 * 1024 + 1024, onDispatch: () => { dispatched = true; } });
    } catch (error) {
      if (dispatched && (signal?.aborted || error?.name === "AbortError"
        || ["runtime_controller_timeout", "runtime_controller_unavailable", "runtime_controller_response_too_large"].includes(error?.code))) {
        try {
          const joined = await this.cancelPersonalSkill(reference);
          if (joined?.cancelled !== true) throw new Error("cancel_unknown");
        } catch {
          throw controllerError("product_state_unavailable", "Skill validation cancellation could not be confirmed.");
        }
      }
      throw error;
    }
  }

  cancelPersonalSkill(reference) {
    return this.request("POST", "/v1/skills/cancel", reference, { timeoutMs: 45000 });
  }

  extensionToolAdmission() { return this.request("POST", "/v1/extensions/tool/admission", {}); }
  async admissionAvailable() { return (await this.extensionToolAdmission())?.available === true; }

  /** The private worker supplies an opaque leased identity; cancellation joins even after the HTTP response is lost.
   * @param {'prepare'|'execute'} kind @param {any} body @param {{signal?:AbortSignal}} [options] */
  async extensionToolRequest(kind, body, { signal } = {}) {
    let dispatched = false;
    try {
      return await this.request("POST", `/v1/extensions/tool/${kind}`, body,
        { signal, timeoutMs: 45000, maxResponseBytes: 12 * 1024 * 1024 + 16384, onDispatch: () => { dispatched = true; } });
    } catch (error) {
      if (dispatched) {
        try {
          const ack = await this.request("POST", "/v1/extensions/tool/cancel", { kind, identity: body.identity }, { timeoutMs: 45000 });
          if (ack?.joined !== true || ack?.physicallyAbsent !== true || canonicalJson(ack.identity) !== canonicalJson(body.identity)) throw new Error("cancel_unknown");
          error.joined = true; error.physicallyAbsent = true;
        } catch {
          throw Object.assign(controllerError("product_state_unavailable", "Extension cancellation could not be confirmed."), { joined: false });
        }
      }
      throw error;
    }
  }

  prepareExtensionTool(body, options = {}) { return this.extensionToolRequest("prepare", body, options); }
  executeExtensionTool(body, options = {}) { return this.extensionToolRequest("execute", body, options); }
  prepare(body, options = {}) { return this.prepareExtensionTool(body, options); }
  execute(body, options = {}) { return this.executeExtensionTool(body, options); }
  cancelPreparation(identity) { return this.request("POST", "/v1/extensions/tool/cancel", { kind: "prepare", identity }, { timeoutMs: 45000 }); }
  cancelExecution(identity) { return this.request("POST", "/v1/extensions/tool/cancel", { kind: "execute", identity }, { timeoutMs: 45000 }); }
  executionStatus(identity) { return this.request("POST", "/v1/extensions/tool/status", { identity }); }

  async health() {
    const result = await this.request("GET", "/v1/health");
    if (result.protocolVersion !== RUNTIME_CONTROLLER_PROTOCOL_VERSION) {
      throw controllerError("runtime_controller_protocol_mismatch", "Runtime controller protocol version does not match the API.");
    }
    return result;
  }

  dockerInfo() {
    return this.request("GET", "/v1/docker/info");
  }

  inspectRuntimeImage() {
    return this.request("GET", "/v1/docker/runtime-image");
  }

  startRuntime(project, port, password, capsuleGatewayUrl = "", revisionGatewayUrl = "", publicSourceGatewayUrl = "", pluginConfig = { revision: 0, enabled: true, settings: { timeoutMs: 15000 } }, personalSkillGeneration = null, extensionGeneration = null) {
    return this.request("POST", "/v1/runtime/start", {
      ...projectReference(project),
      port,
      password,
      capsuleGatewayUrl,
      revisionGatewayUrl,
      publicSourceGatewayUrl,
      pluginConfig,
      ...(personalSkillGeneration ? { personalSkillGeneration } : {}),
      ...(extensionGeneration ? { extensionGeneration } : {}),
    });
  }

  cleanupRuntime(project) {
    return this.request("POST", "/v1/runtime/cleanup", projectReference(project));
  }

  runtimeStatus(project) {
    const query = new URLSearchParams(projectReference(project));
    return this.request("GET", `/v1/runtime/status?${query}`);
  }
}
