// A scratch copy of the web folder (just what gets uploaded) that a test may damage on purpose, to see the checks notice.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The real web folder (two levels above tests/unit). Tests read from it; they never write into it. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function makeBundleCopy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evoting-bundle-'));
  for (const name of ['config.js', 'index.html', '_headers', 'favicon.svg']) await cp(path.join(ROOT, name), path.join(dir, name));
  for (const name of ['css', 'js', 'vendor']) await cp(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  return {
    dir,
    file: (name) => path.join(dir, name),
    read: (name) => readFile(path.join(dir, name), 'utf8'),
    write: (name, text) => writeFile(path.join(dir, name), text),
    /** Changes a file with a function of its text. */
    async edit(name, change) {
      const before = await readFile(path.join(dir, name), 'utf8');
      const after = change(before);
      if (after === before) throw new Error(`the change to ${name} did nothing`);
      await writeFile(path.join(dir, name), after);
    },
    append: async (name, text) => writeFile(path.join(dir, name), (await readFile(path.join(dir, name), 'utf8')) + text),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Runs `fn(copy)` on a fresh copy and removes the copy afterwards. */
export async function withBundleCopy(fn) {
  const copy = await makeBundleCopy();
  try {
    return await fn(copy);
  } finally {
    await copy.cleanup();
  }
}
