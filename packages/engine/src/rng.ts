// Mulberry32: schneller, seeded PRNG — kein Math.random()
export function createRng(seed: number): () => number {
  let s = seed >>> 0
  return function next(): number {
    s += 0x6d2b79f5
    let z = s
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000
  }
}
