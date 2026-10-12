export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** Line-diff via LCS, with a size guard that falls back to whole-file replace. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length
  // Guard on the PRODUCT: the DP matrix is (n+1)×(m+1), so a sum guard still
  // admitted 2000×2000 ≈ 4M cells (~32MB of number[] rows, UI-thread stall).
  if (n * m > 1_000_000) {
    return [
      ...a.map((t) => ({ type: 'del' as const, text: t })),
      ...b.map((t) => ({ type: 'add' as const, text: t }))
    ]
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ type: 'add', text: b[j] })
      j++
    } else if (i < n) {
      out.push({ type: 'del', text: a[i] })
      i++
    }
  }
  return out
}
