// Routing uses the same online policy and the preserved title-to-paper set.
if (!process.argv.includes('--site')) process.argv.push('--site', 'J3');
await import('../judge-sites/run.mjs');
