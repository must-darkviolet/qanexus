/**
 * Database access.
 *
 * PostgreSQL is the production target named by the spec. An embedded SQLite
 * file is also supported so the full demo can run with no infrastructure -
 * both drivers sit behind one interface and the schema uses a portable SQL
 * subset, so switching is only a DATABASE_URL change.
 *
 * Repository code always writes `?` placeholders; the Postgres driver rewrites
 * them to `$1..$n`.
 */
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import fs from 'node:fs';
import path from 'node:path';

const log = createLogger('db');

export type Dialect = 'postgres' | 'sqlite';

export interface Db {
  readonly dialect: Dialect;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function toPgPlaceholders(sql: string): string {
  let i = 0;
  // Only rewrite `?` outside of string literals.
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let c = 0; c < sql.length; c++) {
    const ch = sql[c]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '?' && !inSingle && !inDouble) { out += `$${++i}`; continue; }
    out += ch;
  }
  return out;
}

/** Booleans are stored as 0/1 so the same rows work in both engines. */
function normalizeParams(params: readonly unknown[] | undefined): unknown[] {
  return (params ?? []).map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (p !== null && typeof p === 'object') return JSON.stringify(p);
    return p;
  });
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL                                                                  */
/* -------------------------------------------------------------------------- */
class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  constructor(private readonly pool: import('pg').Pool, private readonly client?: import('pg').PoolClient) {}

  private get executor() { return this.client ?? this.pool; }

  async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    const res = await this.executor.query(toPgPlaceholders(sql), normalizeParams(params));
    return res.rows as T[];
  }
  async one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
  async run(sql: string, params?: readonly unknown[]): Promise<void> { await this.query(sql, params); }
  async exec(sql: string): Promise<void> { await this.executor.query(sql); }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this); // already inside a transaction
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresDb(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

/* -------------------------------------------------------------------------- */
/* SQLite (node:sqlite, built into Node >= 22.5)                               */
/* -------------------------------------------------------------------------- */
class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  constructor(private readonly db: any, private readonly inTx = false) {}

  async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const p = normalizeParams(params);
    if (/^\s*(select|with|pragma)/i.test(sql) || /returning/i.test(sql)) {
      return stmt.all(...p) as T[];
    }
    stmt.run(...p);
    return [];
  }
  async one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
  async run(sql: string, params?: readonly unknown[]): Promise<void> { await this.query(sql, params); }
  async exec(sql: string): Promise<void> { this.db.exec(sql); }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    this.db.exec('BEGIN');
    try {
      const result = await fn(new SqliteDb(this.db, true));
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }
  async close(): Promise<void> { this.db.close(); }
}

let instance: Db | null = null;

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  const url = env.DATABASE_URL;

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url, max: 10 });
    await pool.query('SELECT 1');
    log.info('Connected to PostgreSQL.');
    instance = new PostgresDb(pool);
    return instance;
  }

  if (url.startsWith('sqlite:')) {
    const file = url.slice('sqlite:'.length);
    const { DatabaseSync } = await import('node:sqlite');

    // `sqlite::memory:` is an in-memory database, used by the test suite. It
    // must not be treated as a relative filename.
    if (file === ':memory:' || file === '') {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      log.info('Connected to an in-memory SQLite database.');
      instance = new SqliteDb(db);
      return instance;
    }

    const resolved = path.isAbsolute(file) ? file : path.resolve(env.rootDir, file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new DatabaseSync(resolved);
    // WAL is a file-database concern only.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    log.info(`Connected to embedded SQLite at ${resolved}`);
    instance = new SqliteDb(db);
    return instance;
  }

  throw new Error(`Unsupported DATABASE_URL: expected postgres:// or sqlite:, got "${url.split(':')[0]}:"`);
}

export async function closeDb(): Promise<void> {
  if (instance) { await instance.close(); instance = null; }
}

/** JSON columns are stored as TEXT in both engines for portability. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    const parsed = JSON.parse(String(value));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}
