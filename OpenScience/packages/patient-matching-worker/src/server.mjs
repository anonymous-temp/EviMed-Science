import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createWorkerServer } from './service.mjs';
import { listenWorkerSocket } from './listen.mjs';

const tokenFile = process.env.PATIENT_MATCHING_WORKER_TOKEN_FILE;
const socketPath = process.env.PATIENT_MATCHING_WORKER_SOCKET;
if (!tokenFile || !socketPath) throw new Error('Worker token file and Unix socket are required.');
const server = createWorkerServer({ readToken: async () => {
  const handle = await fs.open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error('Private worker credentials required.');
    return (await handle.readFile('utf8')).trim();
  } finally { await handle.close(); }
} });
await listenWorkerSocket(server, socketPath);
server.on('error', () => { process.stderr.write('matching_worker_socket_failed\n'); server.close(); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
