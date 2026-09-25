/**
 * Repository change detection (spec section 8).
 *
 * "Every analysis must compare the current repository against the previous
 * analyzed version." Git tells us which files changed; AST comparison tells us
 * which *functions, components, routes, APIs and validation rules* changed,
 * which is what drives regression selection.
 */
import type { ChangedFile, RepositoryDiff, StaticAnalysis } from '@qa-agent/shared';
import { commitsBetween, diffCommits, fileAtCommit, commitExists, type RawDiffFile } from '../github/workspace.js';
import { parseSource, topLevelFunctions } from './ast.js';
import { extractApis } from './apis.js';
import { extractRoutes } from './routes.js';
import { extractValidations } from './validation.js';
import { isCodeFile, type ScannedFile } from './scanner.js';
import { sha256 } from '../util/ids.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('change-detector');

/** Files whose change is very likely to change behaviour, not just styling. */
function isBusinessLogicFile(p: string): boolean {
  if (!isCodeFile(p)) return false;
  if (/\.(css|scss|test|spec|cy)\./.test(p)) return false;
  return /(service|api|validation|schema|permission|auth|role|store|reducer|slice|hook|util|helper|constant|config|model|entity|type)/i.test(p)
    || /(^|\/)(src\/)?(app|pages|features|modules|components)\//.test(p);
}

/** Compares the top-level declarations of a file before and after. */
function diffFunctions(filePath: string, before: string | null, after: string | null) {
  const changes: { file: string; name: string; change: 'added' | 'removed' | 'modified' }[] = [];
  const mapOf = (content: string | null) => {
    if (!content) return new Map<string, string>();
    try {
      const sf = parseSource(filePath, content);
      return new Map(topLevelFunctions(sf).map((f) => [f.name, sha256(f.text.replace(/\s+/g, ' '))]));
    } catch {
      return new Map<string, string>();
    }
  };
  const oldMap = mapOf(before);
  const newMap = mapOf(after);

  for (const [name, hash] of newMap) {
    const previous = oldMap.get(name);
    if (previous === undefined) changes.push({ file: filePath, name, change: 'added' });
    else if (previous !== hash) changes.push({ file: filePath, name, change: 'modified' });
  }
  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) changes.push({ file: filePath, name, change: 'removed' });
  }
  return changes;
}

/** Builds a fake ScannedFile so the extractors can run on historical content. */
function asScanned(path: string, content: string): ScannedFile {
  return {
    path, absPath: path, size: content.length, hash: sha256(content),
    language: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : path.endsWith('.jsx') ? 'jsx' : 'js',
    content, isTest: false, isTooLarge: false,
  };
}

function diffKeyedList<T>(
  before: T[], after: T[], key: (t: T) => string,
): { key: string; change: 'added' | 'removed' | 'modified'; item: T }[] {
  const out: { key: string; change: 'added' | 'removed' | 'modified'; item: T }[] = [];
  const beforeMap = new Map(before.map((b) => [key(b), b]));
  const afterMap = new Map(after.map((a) => [key(a), a]));
  for (const [k, item] of afterMap) {
    const prev = beforeMap.get(k);
    if (!prev) out.push({ key: k, change: 'added', item });
    else if (JSON.stringify(prev) !== JSON.stringify(item)) out.push({ key: k, change: 'modified', item });
  }
  for (const [k, item] of beforeMap) {
    if (!afterMap.has(k)) out.push({ key: k, change: 'removed', item });
  }
  return out;
}

export interface DetectChangesOptions {
  repoDir: string;
  previousCommitSha: string | null;
  currentCommitSha: string;
  currentFiles: ScannedFile[];
  previousFileHashes: Record<string, string> | null;
}

export async function detectChanges(opts: DetectChangesOptions): Promise<RepositoryDiff> {
  const { repoDir, previousCommitSha, currentCommitSha, currentFiles, previousFileHashes } = opts;

  if (!previousCommitSha) {
    log.info('No previous analysis recorded - treating this as the first analysis.');
    return {
      previousCommitSha: null,
      currentCommitSha,
      isFirstAnalysis: true,
      files: [],
      changedFunctions: [],
      changedComponents: [],
      changedRoutes: [],
      changedApis: [],
      changedValidations: [],
      changedBusinessLogicFiles: [],
      commits: [],
    };
  }

  if (previousCommitSha === currentCommitSha) {
    log.info(`Commit ${currentCommitSha.slice(0, 8)} was already analyzed - no repository changes.`);
    return {
      previousCommitSha, currentCommitSha, isFirstAnalysis: false,
      files: [], changedFunctions: [], changedComponents: [], changedRoutes: [],
      changedApis: [], changedValidations: [], changedBusinessLogicFiles: [], commits: [],
    };
  }

  let raw: RawDiffFile[] = [];
  const havePrevious = await commitExists(repoDir, previousCommitSha);
  if (havePrevious) {
    raw = await diffCommits(repoDir, previousCommitSha, currentCommitSha);
  } else {
    // The previous commit is not in this clone (force-push, shallow history).
    // Fall back to the stored file hashes, which is exactly why we keep them.
    log.warn(`Previous commit ${previousCommitSha.slice(0, 8)} is not reachable; falling back to stored file hashes.`);
    const previous = previousFileHashes ?? {};
    const currentByPath = new Map(currentFiles.map((f) => [f.path, f]));
    for (const [path, hash] of Object.entries(previous)) {
      const current = currentByPath.get(path);
      if (!current) raw.push({ path, status: 'deleted', additions: 0, deletions: 0 });
      else if (current.hash !== hash) raw.push({ path, status: 'modified', additions: 0, deletions: 0 });
    }
    for (const file of currentFiles) {
      if (!(file.path in previous)) raw.push({ path: file.path, status: 'added', additions: 0, deletions: 0 });
    }
  }

  const currentByPath = new Map(currentFiles.map((f) => [f.path, f]));
  const commits = havePrevious ? await commitsBetween(repoDir, previousCommitSha, currentCommitSha) : [];

  return buildRepositoryDiff({
    raw,
    previousCommitSha,
    currentCommitSha,
    commits,
    readBefore: (p) => (havePrevious ? fileAtCommit(repoDir, previousCommitSha, p) : Promise.resolve(null)),
    readAfter: (p) => Promise.resolve(currentByPath.get(p)?.content ?? null),
  });
}

/**
 * Turns a raw file-level diff into the structural diff the rest of the system
 * works with: which functions, components, routes, APIs and validation rules
 * moved. Independent of where the change came from, so the same logic serves
 * commit-to-commit comparisons, arbitrary ref ranges and uncommitted work.
 */
export async function buildRepositoryDiff(opts: {
  raw: RawDiffFile[];
  previousCommitSha: string | null;
  currentCommitSha: string;
  commits: RepositoryDiff['commits'];
  readBefore: (path: string) => Promise<string | null>;
  readAfter: (path: string) => Promise<string | null>;
}): Promise<RepositoryDiff> {
  const { raw, previousCommitSha, currentCommitSha, commits, readBefore, readAfter } = opts;

  const files: ChangedFile[] = raw.map((f) => ({
    path: f.path,
    previousPath: f.previousPath,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));

  /* ---- AST-level comparison for code files ----------------------------- */
  const changedFunctions: RepositoryDiff['changedFunctions'] = [];
  const changedComponents = new Set<string>();
  const beforeFiles: ScannedFile[] = [];
  const afterFiles: ScannedFile[] = [];

  for (const file of files) {
    if (!isCodeFile(file.path)) continue;
    const sourcePathBefore = file.previousPath ?? file.path;
    const before = file.status !== 'added' ? await readBefore(sourcePathBefore) : null;
    const after = file.status === 'deleted' ? null : await readAfter(file.path);

    const fnChanges = diffFunctions(file.path, before, after);
    changedFunctions.push(...fnChanges);

    if (before) beforeFiles.push(asScanned(sourcePathBefore, before));
    if (after) afterFiles.push(asScanned(file.path, after));

    // React components are the exported PascalCase declarations that changed.
    for (const fn of fnChanges) {
      if (/^[A-Z]/.test(fn.name)) changedComponents.add(fn.name);
    }
  }

  const changedRoutes = diffKeyedList(
    extractRoutes(beforeFiles), extractRoutes(afterFiles), (r) => r.path,
  ).map(({ key, change }) => ({ path: key, change }));

  const changedApis = diffKeyedList(
    extractApis(beforeFiles), extractApis(afterFiles), (a) => `${a.method} ${a.path}`,
  ).map(({ change, item }) => ({ method: item.method, path: item.path, change }));

  const changedValidations = diffKeyedList(
    extractValidations(beforeFiles), extractValidations(afterFiles),
    (v) => `${v.file}|${v.field}|${v.rule}`,
  ).map(({ change, item }) => ({ field: item.field, file: item.file, change }));

  const changedBusinessLogicFiles = files
    .filter((f) => isBusinessLogicFile(f.path))
    .map((f) => f.path);

  log.info(
    `Change detection: ${files.length} files, ${changedFunctions.length} functions, ` +
    `${changedRoutes.length} routes, ${changedApis.length} APIs, ${changedValidations.length} validation rules.`,
  );

  return {
    previousCommitSha,
    currentCommitSha,
    isFirstAnalysis: false,
    files,
    changedFunctions,
    changedComponents: [...changedComponents],
    changedRoutes,
    changedApis,
    changedValidations,
    changedBusinessLogicFiles,
    commits,
  };
}

/** Files whose content hash is unchanged since the last analysis. */
export function unchangedFiles(
  currentFiles: ScannedFile[],
  previousHashes: Record<string, string> | null,
): Set<string> {
  const unchanged = new Set<string>();
  if (!previousHashes) return unchanged;
  for (const file of currentFiles) {
    if (previousHashes[file.path] === file.hash) unchanged.add(file.path);
  }
  return unchanged;
}

export { isBusinessLogicFile };
export type { StaticAnalysis };
