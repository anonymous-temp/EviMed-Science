/** Collapse consecutive exact command-log lines; never summarize scientific data. */
/** @param {string} text @returns {string} */
export function collapseDuplicateLines(text) {
  const lines = text.split('\n')
  const out = []
  for (let index = 0; index < lines.length;) {
    let end = index + 1
    while (end < lines.length && lines[end] === lines[index]) end++
    const count = end - index
    if (count >= 3 && lines[index].trim()) out.push(lines[index], `(重复 ${count} 次)`)
    else out.push(...lines.slice(index, end))
    index = end
  }
  return out.join('\n')
}

/** @param {string} name @param {any} result @param {Record<string, unknown>} [args] @returns {any} */
export function compactCommandResult(name, result, args = {}) {
  if (name !== 'bash' || !result || !Array.isArray(result.content)) return result
  // Bash can also print research tables. Restrict reduction to ordinary
  // build/install/test log commands; arbitrary scripts and file reads bypass it.
  const command = String(args.command ?? '').trim()
  if ([';', '|', '&', '\n', '>', '<', '`', '$'].some((part) => command.includes(part))) return result
  const words = command.split(' ').filter(Boolean)
  const executable = words[0]
  const logCommand = ['npm', 'pnpm', 'yarn'].includes(executable) && ['install', 'test', 'build', 'lint'].includes(words[1])
    || ['pip', 'pip3'].includes(executable) && words[1] === 'install'
    || executable === 'pytest'
  if (!logCommand) return result
  // Canonical structured values, files and tables stay byte-for-byte intact.
  if (result.structuredContent != null || result.value?.structuredContent != null) return result
  // DSH re-renders a wrapper-authored success from its canonical value.
  // Preserve exit status and truncation metadata while compacting only the
  // foreground bash stream text, so normalization keeps this reduction.
  const value = result.value
  const compactedValue = value && typeof value === 'object'
    && typeof value.stdout?.text === 'string' && typeof value.stderr?.text === 'string'
    ? { ...value, stdout: { ...value.stdout, text: collapseDuplicateLines(value.stdout.text) },
      stderr: { ...value.stderr, text: collapseDuplicateLines(value.stderr.text) } } : value
  return { ...result, ...(compactedValue !== value ? { value: compactedValue } : {}), content: result.content.map((/** @type {any} */ block) =>
    block?.type === 'text' && typeof block.text === 'string'
      ? { ...block, text: collapseDuplicateLines(block.text) } : block) }
}
