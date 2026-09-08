import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { apply, inject } from '../client.mjs';

const output = new URL('../dist/client.js', import.meta.url);
await mkdir(fileURLToPath(new URL('.', output)), { recursive: true });
// The port owns the complete browser body, so this bundle needs no dynamic
// imports or duplicated upstream libraries. The native loader owns execution.
// Published atomically, because this file has five readers and two of them
// rebuild it. `node --test test/*.test.mjs` runs the files of one package
// concurrently, so a plain write truncates the bundle under a reader that is
// part-way through it: the reader gets a prefix, `__ModuleLoader__.load` is
// never called, and the failure reads as "the scanner omitted the client"
// rather than as the file race it is. Rename is atomic within a directory, so
// every reader sees either the previous bundle or the whole new one.
const staging = new URL(`../dist/.client.${process.pid}.js`, import.meta.url);
await writeFile(staging, `globalThis.__ModuleLoader__.load({\n  id: '@evimed/dsh-socket',\n  factory: () => ({ inject: ${JSON.stringify(inject)}, apply: ${apply.toString()} })\n});\n`);
await rename(staging, output);
