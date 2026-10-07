/** One-sided 95% exact binomial lower bound (Clopper-Pearson). */
export function lowerConfidenceBound(successes, total, alpha = 0.05) {
  if (!Number.isInteger(total) || !Number.isInteger(successes) || total < 0 || successes < 0 || successes > total) throw new RangeError('Invalid counts');
  if (!total || !successes) return 0;
  if (successes === total) return alpha ** (1 / total);
  const logFactorial = [0];
  for (let n = 1; n <= total; n++) logFactorial[n] = logFactorial[n - 1] + Math.log(n);
  const tail = p => {
    let sum = 0;
    for (let k = successes; k <= total; k++) sum += Math.exp(logFactorial[total] - logFactorial[k] - logFactorial[total - k]
      + k * Math.log(p) + (total - k) * Math.log1p(-p));
    return sum;
  };
  let low = 0, high = 1;
  for (let step = 0; step < 70; step++) {
    const middle = (low + high) / 2;
    if (tail(middle) < alpha) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

/** Exploratory threshold recommendation; report it separately from the fixed threshold. */
export function recommendThreshold(rows, target = 0.95) {
  const candidates = [...new Set(rows.map(row => row.confidence))].filter(Number.isFinite).sort((a, b) => a - b);
  for (const threshold of candidates) {
    const kept = rows.filter(row => row.confidence >= threshold);
    const correct = kept.filter(row => row.correct).length;
    const lower95 = lowerConfidenceBound(correct, kept.length);
    if (lower95 >= target) return { threshold, settled: kept.length, correct, lower95, exploratory: true };
  }
  return null;
}
