/** Explicitly isolated paths and origins for the synthetic acceptance fixture. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
export function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Only explicit loopback HTTP origins are allowed');
  return url.origin;
}
export function fixtureConfig(env = process.env) {
  if (env.EVIMED_LOCAL_NATIVE_ACCEPTANCE !== '1') throw new Error('Explicit local acceptance opt-in is required');
  for (const name of Object.keys(env)) if (/^(DATABASE_URL|PGPASSWORD|OPEN_SCIENCE_|DEEPSEEK_API_KEY|DASHSCOPE_API_KEY)/.test(name) && env[name]) throw new Error(`Production environment is forbidden: ${name}`);
  const root = path.resolve(env.EVIMED_ACCEPTANCE_ROOT ?? '/acceptance');
  if (!root.startsWith('/tmp/evimed-native-') && root !== '/acceptance') throw new Error('Acceptance root must be an owned /tmp/evimed-native-* directory or /acceptance');
  if (env.EVIMED_ACCEPTANCE_THEME_OFF && !['0', '1'].includes(env.EVIMED_ACCEPTANCE_THEME_OFF)) throw new Error('Theme-off fixture switch must be 0 or 1');
  const themeOff = env.EVIMED_ACCEPTANCE_THEME_OFF === '1';
  const streamLines = Number(env.EVIMED_ACCEPTANCE_STREAM_LINES ?? 0);
  if (!Number.isInteger(streamLines) || streamLines < 0 || streamLines > 80) throw new Error('Synthetic stream lines must be an integer from 0 to 80');
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  return { root, repo, streamLines, themeOff, seed: path.join(root, 'seed'), socket: path.join(root, 'socket-source'), kernelModules: path.resolve(env.EVIMED_ACCEPTANCE_KERNEL_MODULES ?? '/app/harness/node_modules'), shellOrigin: loopbackOrigin(env.EVIMED_ACCEPTANCE_SHELL_ORIGIN), uiOrigin: loopbackOrigin(env.EVIMED_ACCEPTANCE_UI_ORIGIN), pins: JSON.parse(readFileSync(path.join(repo, 'deps-version.json'), 'utf8')).dsh };
}
export function childEnvironment(extra) {
  return { PATH: process.env.PATH, HOME: extra.DSH_HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', ...extra };
}
