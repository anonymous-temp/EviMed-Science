import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { apply, inject } from '../client.mjs';

const output = new URL('../dist/client.js', import.meta.url);
await mkdir(fileURLToPath(new URL('.', output)), { recursive: true });
// The port owns the complete browser body, so this bundle needs no dynamic
// imports or duplicated upstream libraries. The native loader owns execution.
await writeFile(output, `globalThis.__ModuleLoader__.load({\n  id: '@evimed/dsh-socket',\n  factory: () => ({ inject: ${JSON.stringify(inject)}, apply: ${apply.toString()} })\n});\n`);
