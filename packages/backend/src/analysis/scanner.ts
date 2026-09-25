/**
 * Repository file scanner.
 *
 * Walks a checked-out repository, hashes every file (so unchanged files are
 * never re-analyzed or re-sent to a model - spec section 26), and refuses to
 * read anything that looks like it holds secrets (spec section 27).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RepoFile } from '@qa-agent/shared';
import { sha256 } from '../util/ids.js';
import { detectSecrets, isSecretFile } from './secrets.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('scanner');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.cache', '.vercel', '.yarn', 'vendor', '__snapshots__',
  '.pnpm-store', 'target', '.idea', '.vscode', 'storybook-static',
]);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.md', '.mdx', '.css', '.scss', '.yml', '.yaml', '.html']);

/** Files larger than this are hashed but their contents are chunked, not inlined. */
export const LARGE_FILE_BYTES = 120_000;
const MAX_FILE_BYTES = 2_000_000;

export interface ScannedFile extends RepoFile {
  absPath: string;
  /** Undefined for binary, oversized, or secret-bearing files. */
  content?: string;
  isTest: boolean;
  isTooLarge: boolean;
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  excludedForSecrets: string[];
  totalBytes: number;
}

function languageOf(file: string): RepoFile['language'] {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ts') return 'ts';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  if (ext === '.json') return 'json';
  if (ext === '.md' || ext === '.mdx') return 'md';
  if (ext === '.css' || ext === '.scss') return 'css';
  return 'other';
}

export function isTestFile(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return /(^|\/)(cypress|e2e|tests?|__tests__)\//i.test(p)
    || /\.(cy|spec|test)\.[jt]sx?$/i.test(p);
}

export function isCodeFile(rel: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

export function scanRepository(root: string): ScanResult {
  const files: ScannedFile[] = [];
  const excludedForSecrets: string[] = [];
  let totalBytes = 0;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      log.warn(`Cannot read directory ${dir}: ${(e as Error).message}`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext) && entry.name !== '.env.example' && !/^(readme|license|changelog)/i.test(entry.name)) {
        continue;
      }

      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;
      totalBytes += stat.size;

      if (isSecretFile(rel)) {
        excludedForSecrets.push(rel);
        // Hash it so we still notice it changed, but never read the contents.
        files.push({
          path: rel, absPath: abs, size: stat.size,
          hash: sha256(`secret-file:${rel}:${stat.size}:${stat.mtimeMs}`),
          language: languageOf(rel), isTest: false, isTooLarge: false,
        });
        continue;
      }

      let content: string;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }

      // A file that is not named like a secret file can still contain one.
      const findings = detectSecrets(content);
      if (findings.length >= 2) {
        excludedForSecrets.push(rel);
        log.warn(`Excluding ${rel} from AI context: ${findings.length} possible secret(s) detected.`);
        files.push({
          path: rel, absPath: abs, size: stat.size, hash: sha256(content),
          language: languageOf(rel), isTest: isTestFile(rel), isTooLarge: false,
        });
        continue;
      }

      files.push({
        path: rel,
        absPath: abs,
        size: stat.size,
        hash: sha256(content),
        language: languageOf(rel),
        content,
        isTest: isTestFile(rel),
        isTooLarge: stat.size > LARGE_FILE_BYTES,
      });
    }
  };

  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  log.info(`Scanned ${files.length} files (${Math.round(totalBytes / 1024)} KB), excluded ${excludedForSecrets.length} for secrets.`);
  return { root, files, excludedForSecrets, totalBytes };
}

/** Map of path -> content hash, stored as the repository memory snapshot. */
export function fileHashMap(files: ScannedFile[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of files) map[f.path] = f.hash;
  return map;
}
