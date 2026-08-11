export function percentile(values, point) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(point * sorted.length) - 1));
  return sorted[index];
}

export function summarizeNumbers(values) {
  const valid = values.filter(Number.isFinite);
  return {
    count: valid.length,
    min: valid.length ? Math.min(...valid) : null,
    median: percentile(valid, 0.5),
    p95: percentile(valid, 0.95),
    max: valid.length ? Math.max(...valid) : null
  };
}

export function normalizedText(value) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function wordErrorRate(reference, hypothesis) {
  const a = normalizedText(reference).split(" ").filter(Boolean);
  const b = normalizedText(hypothesis).split(" ").filter(Boolean);
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      matrix[i][j] = a[i - 1] === b[j - 1]
        ? matrix[i - 1][j - 1]
        : 1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
    }
  }
  return a.length ? matrix[a.length][b.length] / a.length : b.length ? 1 : 0;
}
