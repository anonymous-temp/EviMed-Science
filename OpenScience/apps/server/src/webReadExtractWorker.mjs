/**
 * The thread one HTML page is parsed in (`extractHtmlIsolated` in
 * webReadExtract.mjs): one page, one answer, then the thread ends — or is
 * terminated, which is the point of running here rather than on the event
 * loop.
 *
 * @module webReadExtractWorker
 */

import { parentPort, workerData } from "node:worker_threads";

import { extractHtml } from "./webReadExtract.mjs";

try {
  parentPort?.postMessage({ page: extractHtml(workerData.html, { baseUrl: workerData.baseUrl }) });
} catch (error) {
  // Only the kind leaves: nothing a hostile page put in an exception is
  // repeated to the caller.
  parentPort?.postMessage({ failed: error instanceof RangeError ? "RangeError" : "Error" });
}
