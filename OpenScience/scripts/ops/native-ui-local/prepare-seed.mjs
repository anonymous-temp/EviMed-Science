/** Build-only immutable fixture using the exact installed rc.1 closure. */
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { sealProfileSeed } from "../../../deploy/runtime-dsh/profile-seed.mjs";
const profile = "/opt/evimed/seed/profiles/evimed-runtime";
mkdirSync(`${profile}/node_modules/@deepseek-ai`, { recursive: true });
mkdirSync(`${profile}/node_modules/@evimed`, { recursive: true });
for (const name of ["dsh-base", "dsh-web-app"]) symlinkSync(`/app/harness/node_modules/@deepseek-ai/${name}`, `${profile}/node_modules/@deepseek-ai/${name}`);
cpSync("/opt/evimed/socket-source", `${profile}/node_modules/@evimed/dsh-socket`, { recursive: true, dereference: false, verbatimSymlinks: true });
writeFileSync(`${profile}/package.json`, JSON.stringify({ name: "evimed-native-acceptance-profile", private: true,
  dependencies: { "@deepseek-ai/dsh-base": "0.1.2-rc.1", "@deepseek-ai/dsh-web-app": "0.1.2-rc.1", "@evimed/dsh-socket": "file:/opt/evimed/socket-source" },
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@evimed/dsh-socket"], patchReload: "startup" } } }));
writeFileSync(`${profile}/pnpm-workspace.yaml`, "packages:\n  - .\n");
sealProfileSeed("/opt/evimed/seed", "evimed-runtime");
