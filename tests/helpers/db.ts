import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build a throwaway SQLite database with the real schema and the real
 * append-only triggers, so gateway tests exercise the same guarantees
 * production does rather than a simplified stand-in.
 */
export function createTestDatabase(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gmt-${label}-`));
  const file = path.join(dir, 'test.db');

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const migrationsDir = path.join(process.cwd(), 'drizzle');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    for (const statement of sql.split(/--> statement-breakpoint/).map((s) => s.trim()).filter(Boolean)) {
      db.exec(statement);
    }
  }

  db.exec(`
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted'); END;
    CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not permitted'); END;
  `);
  db.exec(`INSERT OR IGNORE INTO gateway_state (id, locked, updated_at) VALUES (1, 0, ${Date.now()});`);
  db.close();

  return file;
}

export function destroyTestDatabase(file: string): void {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}
