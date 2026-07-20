import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { HttpError } from "./security.mjs";

export const RUNTIME_CONTROLLER_PROTOCOL_VERSION = 2;

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
    this.maxKernelOutputBytes = Number(config.maxKernelOutputBytes) || 1024 * 1024;
    this.kernelTimeoutMs = Number(config.kernelTimeoutMs) || 10_000;
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
    });
  }

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

  startRuntime(project, port, password) {
    return this.request("POST", "/v1/runtime/start", {
      ...projectReference(project),
      port,
      password,
    });
  }

  cleanupRuntime(project) {
    return this.request("POST", "/v1/runtime/cleanup", projectReference(project));
  }

  runtimeStatus(project) {
    const query = new URLSearchParams(projectReference(project));
    return this.request("GET", `/v1/runtime/status?${query}`);
  }

  runKernel(project, code, signal, language = "python") {
    return this.request(
      "POST",
      "/v1/kernel/run",
      { ...projectReference(project), language, code },
      {
        signal,
        timeoutMs: this.kernelTimeoutMs + this.timeoutMs,
        maxResponseBytes: this.maxKernelOutputBytes * 2 + 64 * 1024,
      },
    );
  }
}
