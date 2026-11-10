// Eval-only observation of the kernel's actual registry. No tools or prompt text are registered.
import fs from 'node:fs';
export const name = 'eval-memory-observer';
export const inject = ['tools'];
export function apply(ctx) {
  const file = process.env.EVAL_MEMORY_TOOLS_FILE;
  if (!file) return;
  const sample = () => {
    const names = ctx.tools.definitions().map(tool => tool.name);
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), names }));
  };
  sample();
  const timer = setInterval(sample, 500);
  timer.unref();
  ctx.on('dispose', () => clearInterval(timer));
}
