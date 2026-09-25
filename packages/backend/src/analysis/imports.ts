/**
 * Module import graph.
 *
 * Component usage (JSX) only shows who *renders* whom. A change to a helper -
 * a permission check, a validation constant, an API client - reaches the UI
 * through plain imports, so impact analysis also needs "who imports this file".
 * Resolves relative specifiers and tsconfig `paths` aliases (e.g. "@/*").
 */
import path from 'node:path';
import type { ScannedFile } from './scanner.js';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SPECIFIER = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

function readAliases(files: ScannedFile[]): { prefix: string; targets: string[] }[] {
  const tsconfig = files.find((f) => /^(tsconfig|jsconfig)\.json$/.test(f.path))?.content;
  const aliases: { prefix: string; targets: string[] }[] = [];
  if (tsconfig) {
    try {
      // tsconfig allows comments and trailing commas; strip the common cases.
      const json = JSON.parse(tsconfig.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'));
      const baseUrl: string = json?.compilerOptions?.baseUrl ?? '.';
      const paths: Record<string, string[]> = json?.compilerOptions?.paths ?? {};
      for (const [pattern, targets] of Object.entries(paths)) {
        aliases.push({
          prefix: pattern.replace(/\*$/, ''),
          targets: targets.map((t) => path.posix.normalize(path.posix.join(baseUrl, t.replace(/\*$/, '')))),
        });
      }
    } catch { /* unparseable tsconfig - fall back to the convention below */ }
  }
  if (!aliases.some((a) => a.prefix === '@/')) aliases.push({ prefix: '@/', targets: ['src/', ''] });
  if (!aliases.some((a) => a.prefix === '~/')) aliases.push({ prefix: '~/', targets: ['src/', 'app/'] });
  return aliases;
}

function resolveCandidate(base: string, known: Set<string>): string | null {
  const clean = base.replace(/^\.\//, '').replace(/\/$/, '');
  if (known.has(clean)) return clean;
  for (const ext of EXTENSIONS) if (known.has(clean + ext)) return clean + ext;
  for (const ext of EXTENSIONS) if (known.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
  return null;
}

/** Maps each file to the files that import it. */
export function buildImportedBy(files: ScannedFile[]): Record<string, string[]> {
  const known = new Set(files.map((f) => f.path));
  const aliases = readAliases(files);
  const importedBy: Record<string, string[]> = {};

  for (const file of files) {
    if (!file.content || !EXTENSIONS.includes(path.extname(file.path))) continue;
    for (const match of file.content.matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;

      let resolved: string | null = null;
      if (spec.startsWith('.')) {
        resolved = resolveCandidate(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec)), known);
      } else {
        for (const alias of aliases) {
          if (!spec.startsWith(alias.prefix)) continue;
          for (const target of alias.targets) {
            resolved = resolveCandidate(path.posix.normalize(target + spec.slice(alias.prefix.length)), known);
            if (resolved) break;
          }
          if (resolved) break;
        }
      }
      if (!resolved || resolved === file.path) continue;
      (importedBy[resolved] ??= []).push(file.path);
    }
  }
  for (const key of Object.keys(importedBy)) importedBy[key] = [...new Set(importedBy[key])];
  return importedBy;
}
