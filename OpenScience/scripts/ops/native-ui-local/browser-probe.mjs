/* global WebSocket */
/** CDP evaluation restricted to this disposable loopback acceptance browser. */
const [selector, expression, surface = "native"] = process.argv.slice(2);
const port = Number(process.env.EVIMED_ACCEPTANCE_CDP_PORT);
if (!Number.isInteger(port) || port < 1024) throw new Error("A local acceptance CDP port is required.");
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find(value => value.url.startsWith("http://127.0.0.1:17879/") && value.url.includes(selector));
if (!tab) throw new Error("No matching local acceptance tab.");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
let id = 0;
const pending = new Map();
const contexts = [];
const socketEvents = [];
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  if (message.method === "Runtime.executionContextCreated") contexts.push(message.params.context);
  if (message.method === "Network.webSocketCreated") socketEvents.push({ type: "created", url: message.params.url });
  if (message.method === "Network.webSocketClosed") socketEvents.push({ type: "closed" });
});
const call = (method, params = {}) => new Promise(resolve => {
  const requestId = ++id; pending.set(requestId, resolve);
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
await call("Runtime.enable");
if (expression === "__offline_navigation__") {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(surface)) throw new Error("Invalid acceptance session identity.");
  const main = contexts.find(value => value.origin === "http://127.0.0.1:17879" && value.auxData?.isDefault);
  await call("Network.enable");
  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await call("Runtime.evaluate", { contextId: main.id, expression: `history.pushState({}, "", "/app/chat/${surface}"); dispatchEvent(new PopStateEvent("popstate"));` });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const deadline = Date.now() + 15000;
  while (!socketEvents.some(event => event.type === "created") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  await new Promise(resolve => setTimeout(resolve, 1000));
  const state = await call("Runtime.evaluate", { contextId: main.id, returnByValue: true, expression: '({url:location.pathname,frame:document.querySelector("iframe")?.src,error:Boolean(document.querySelector("[role=alert]")),loading:Boolean(document.querySelector("[role=status]"))})' });
  process.stdout.write(`${JSON.stringify({socketEvents,state:state.result?.result?.value})}\n`);
  ws.close();
  process.exit(0);
}
const origin = surface === "native" ? "http://127.0.0.1:18443" : "http://127.0.0.1:17879";
const context = contexts.find(value => value.origin === origin && value.auxData?.isDefault);
if (!context) { ws.close(); throw new Error("Acceptance execution context is unavailable."); }
const result = await call("Runtime.evaluate", { contextId: context.id, expression, returnByValue: true, awaitPromise: true });
if (result.result?.exceptionDetails) { ws.close(); throw new Error(result.result.exceptionDetails.text); }
process.stdout.write(`${JSON.stringify(result.result?.result?.value)}\n`);
ws.close();
