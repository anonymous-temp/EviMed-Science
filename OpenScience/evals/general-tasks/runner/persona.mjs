// Arm A's persona: the socket preset carries the kernel persona as a `persona` row whose `prefix` names a medical research
// assistant, and no switch of the control plane reaches it (OPEN_SCIENCE_RUNTIME_DISABLED_SOCKET_PLUGINS turns plugins off, the
// persona is a row of the kernel's own). The control arm replaces that one block with a single neutral sentence, in the
// runtime's own copy of the profile, at launch. Nothing in the tree under test is written.
import fs from 'node:fs/promises';
import path from 'node:path';

export const NEUTRAL_PERSONA = "You are a helpful general-purpose assistant working in {{cwd}}, running on the {{model}} model, and you reply in the user's language.";

/**
 * Replace the folded `prefix: >-` block of the `id: persona` row with one line.
 * @param {string} text a preset YAML file
 * @param {string} sentence
 * @returns {{ text: string, replaced: boolean }}
 */
export function replacePersonaPrefix(text, sentence = NEUTRAL_PERSONA) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-?\s*id:\s*persona\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      const head = /^(\s*)prefix:\s*>-?\s*$/.exec(lines[j]);
      if (!head) continue;
      const indent = head[1].length;
      let end = j + 1;
      while (end < lines.length && (lines[end].trim() === '' || /^\s*/.exec(lines[end])[0].length > indent)) end += 1;
      // A blank line that belongs to what follows the block stays with it.
      while (end > j + 1 && lines[end - 1].trim() === '') end -= 1;
      const next = [...lines.slice(0, j + 1), `${' '.repeat(indent + 2)}${sentence}`, ...lines.slice(end)];
      return { text: next.join('\n'), replaced: true };
    }
  }
  return { text, replaced: false };
}

/**
 * Apply the neutral persona to every preset file of a runtime's profile that carries one. Rewrites by delete-and-create:
 * pnpm hard-links package files from its store, and a write-through would reach the seed.
 * @param {string} dshHome the runtime's own DSH_HOME
 * @param {string} sentence
 * @returns {Promise<string[]>} the files rewritten
 */
export async function applyPersona(dshHome, sentence = NEUTRAL_PERSONA) {
  const socket = await fs.realpath(path.join(dshHome, 'profiles', 'evimed-runtime', 'node_modules', '@evimed', 'dsh-socket'));
  if (!socket.startsWith(`${await fs.realpath(dshHome)}${path.sep}`)) throw new Error(`socket copy is outside the runtime home: ${socket}`);
  const presets = path.join(socket, 'presets');
  const written = [];
  for (const file of [path.join(presets, 'evimed-universal.patch.yml'), path.join(presets, 'evimed-universal', 'agent.cordis.yml')]) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    const result = replacePersonaPrefix(text, sentence);
    if (!result.replaced) continue;
    const mode = (await fs.stat(file)).mode & 0o777;
    await fs.rm(file, { force: true });
    await fs.writeFile(file, result.text, { mode });
    written.push(file);
  }
  if (!written.length) throw new Error('no preset file carries a persona row to replace');
  return written;
}
