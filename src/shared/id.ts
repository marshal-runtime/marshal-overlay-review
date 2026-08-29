/**
 * Tiny dependency-free id factory. Deterministic when supplied a seeded RNG,
 * which keeps unit tests stable.
 */

export type Rng = () => number;

export interface IdFactory {
  (): string;
}

/** Mulberry32 PRNG — small, fast, deterministic. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create an id factory. Ids look like `<prefix>_<base36 counter>_<rand>` so
 * they are sortable by creation order and collision-resistant.
 */
export function createIdFactory(prefix = 'ann', rng: Rng = Math.random): IdFactory {
  let counter = 0;
  return () => {
    counter += 1;
    const rand = Math.floor(rng() * 0xffffff)
      .toString(36)
      .padStart(4, '0');
    return `${prefix}_${counter.toString(36)}_${rand}`;
  };
}
