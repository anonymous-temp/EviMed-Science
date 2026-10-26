/** Build an isolated profile from a verified, already installed kernel closure. */
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sealProfileSeed } from '../../../deploy/runtime-dsh/profile-seed.mjs';
import { verifiedKernelPins } from '../../../deploy/runtime-dsh/profile-kernel-pins.mjs';
import { fixtureConfig } from './config.mjs';
const config = fixtureConfig();
const pins = verifiedKernelPins(path.join(config.kernelModules, '@deepseek-ai/dsh/package.json'), config.pins.version, config.pins.cordis);
const profile = path.join(config.seed, 'profiles/evimed-runtime');
mkdirSync(path.join(profile, 'node_modules/@deepseek-ai'), { recursive: true });
mkdirSync(path.join(profile, 'node_modules/@evimed'), { recursive: true });
for (const name of ['dsh-base', 'dsh-web-app']) symlinkSync(path.join(config.kernelModules, '@deepseek-ai', name), path.join(profile, 'node_modules/@deepseek-ai', name));
cpSync(path.join(config.repo, 'packages/socket'), config.socket, { recursive: true, dereference: false, verbatimSymlinks: true, filter: source => path.basename(source) !== 'node_modules' });
// Resolve workspace dependencies from their original, installed checkout. Copying
// pnpm's relative links would silently leave the socket's agent rows unloaded.
symlinkSync(path.join(config.repo, 'packages/socket/node_modules'), path.join(config.socket, 'node_modules'));
symlinkSync(config.socket, path.join(profile, 'node_modules/@evimed/dsh-socket'));
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'evimed-native-acceptance-profile', private: true, dependencies: { '@deepseek-ai/dsh-base': pins['@deepseek-ai/dsh-base'], '@deepseek-ai/dsh-web-app': pins['@deepseek-ai/dsh-web-app'], '@evimed/dsh-socket': `file:${config.socket}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@evimed/dsh-socket'], patchReload: 'startup' } } }));
writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
sealProfileSeed(config.seed, 'evimed-runtime');
