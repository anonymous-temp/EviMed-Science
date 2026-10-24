// Start the existing real-kernel harness with a process-wide provider interceptor already installed.
// No application/runtime is provisioned until the live aggregate coordinator is verified by the collector.
import fs from 'node:fs/promises';
import { installBudgetFetch } from './budget_proxy.mjs';
if(!process.env.KNOWLEDGE_BUDGET_WIRING)throw new Error('Set KNOWLEDGE_BUDGET_WIRING to private shared coordinator wiring JSON');
const config=JSON.parse(await fs.readFile(process.env.KNOWLEDGE_BUDGET_WIRING,'utf8'));
if(!['baseline','candidate'].includes(config.scope))throw new Error('Harness provider scope must be baseline or candidate');
await installBudgetFetch(config);
// The wrapped fetch is installed before the control-plane modules are imported. A native OpenViking process must use
// the same coordinator through its configured provider proxy; absence of its real boundary proof blocks both collectors.
await import('../general-tasks/runner/harness.mjs');
