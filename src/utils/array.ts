export function intersperse<A>(as: A[], separator: (index: number) => A): A[] {
  return as.flatMap((a, i) => (i ? [separator(i), a] : [a]))
}

export function count<T>(arr: readonly T[], pred: (x: T) => unknown): number {
  return arr.reduce((n, x) => n + (pred(x) ? 1 : 0), 0)
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)]
}
