import 'server-only';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import * as schema from './schema';

/**
 * SQLite handle, shared across the process.
 *
 * Next dev-mode module reloading would otherwise open a new connection on every
 * edit and exhaust file handles, so the instance is parked on globalThis.
 */

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'gmt.db');

export function databasePath(): string {
  const configured = process.env.DATABASE_URL?.trim();
  if (!configured) return DEFAULT_PATH;
  return configured.startsWith('file:') ? configured.slice(5) : configured;
}

function open(): Database.Database {
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL lets the worker write while the web process reads.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

declare global {
  // eslint-disable-next-line no-var
  var __gmtSqlite: Database.Database | undefined;
}

export const sqlite: Database.Database = globalThis.__gmtSqlite ?? open();
if (process.env.NODE_ENV !== 'production') globalThis.__gmtSqlite = sqlite;

export const db = drizzle(sqlite, { schema });
export { schema };
