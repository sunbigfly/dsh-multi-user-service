import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

export function resolveHostPackage(specifier) {
  const entry = process.argv[1], bases = [];
  if (entry) {
    try { bases.push(realpathSync(entry)); } catch { /* missing entry only drops this base */ }
    bases.push(entry);
  }
  bases.push(import.meta.url);
  for (const base of bases) {
    try { return createRequire(base).resolve(specifier); } catch { /* try the next base */ }
  }
  throw new Error(`Host package ${specifier} is unavailable`);
}
