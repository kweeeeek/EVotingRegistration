// A very small test registry (no dependencies): test(name, fn, openOptions). fn receives the session from harness.mjs and the lab.
export const registry = [];

/** @param {string} name  @param {(session: any, lab: any) => Promise<void>} fn  @param {object} [options] passed to lab.open() */
export function test(name, fn, options = {}) {
  registry.push({ name, fn, options });
}
