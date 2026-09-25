/**
 * Migration runner. Applies every .sql file in ./migrations in filename order
 * and records what has been applied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from './client.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('migrate');
const here = path.dirname(fileURLToPath(import.meta.url));

/** Splits a SQL file into statements, ignoring `;` inside string literals. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      current += ch;
      continue;
    }
    if (!inSingle && ch === '-' && next === '-') { inLineComment = true; current += ch; continue; }
    if (ch === "'") inSingle = !inSingle;
    if (ch === ';' && !inSingle) { statements.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter((s) => stripComments(s).length > 0);
}

/** Drops `--` comment lines so comment-only chunks can be discarded. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );

  const dir = path.join(here, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version),
  );

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) { log.debug(`Skipping already applied migration ${version}.`); continue; }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    log.info(`Applying migration ${version}...`);
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(sql)) {
        await tx.exec(statement);
      }
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, new Date().toISOString()]);
    });
  }
  log.info(`Database ready (${files.length} migration file(s), ${applied.size} previously applied).`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((e) => { log.error('Migration failed.', e); process.exit(1); });
}
