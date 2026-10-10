/**
 * The PM ranks sources by the order of the AI Judge's inputs. Rank-order centroid (ROC) weights turn
 * that order into weights that sum to 1, so lower-ranked sources still count, just less:
 * w_i = (1/n) · Σ_{k=i..n} 1/k  →  3 inputs: 61.1% / 27.8% / 11.1%.
 */
export function rocWeights(n: number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`rocWeights: invalid n=${n}`);
  const w: number[] = [];
  for (let i = 1; i <= n; i++) {
    let s = 0;
    for (let k = i; k <= n; k++) s += 1 / k;
    w.push(s / n);
  }
  return w;
}
