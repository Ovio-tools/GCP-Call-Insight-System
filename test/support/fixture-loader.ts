import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The single shared golden-fixture loader (Task 6.3). Reads every `*.json` in `dir` AND in its
 * `reviewed/` subdir (where the export projection + the committed synthetic samples live), parsing
 * each as a fixture of type `T`. `MANIFEST.json` (the export manifest) is skipped so it never
 * parses as a fixture. Files are returned sorted by path for deterministic test ordering.
 *
 * Replaces the loader that was duplicated in the classify and extract parse suites.
 */
export function loadFixtures<T>(dir: string): T[] {
  const files: string[] = [];
  const collect = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.json')) continue;
      if (entry.name === 'MANIFEST.json') continue;
      files.push(join(d, entry.name));
    }
  };
  collect(dir);
  const reviewed = join(dir, 'reviewed');
  if (existsSync(reviewed)) collect(reviewed);
  return files.sort().map((f) => JSON.parse(readFileSync(f, 'utf8')) as T);
}
