/**
 * Create the schema and install the append-only guarantees.
 *
 * Drizzle generates the table DDL from src/lib/db/schema.ts; this script applies
 * it and then adds the parts Drizzle cannot express: SQL triggers that make the
 * audit log genuinely append-only at the database level, not merely by
 * convention in application code.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const target = (() => {
  const configured = process.env.DATABASE_URL?.trim();
  if (!configured) return path.join(process.cwd(), 'data', 'gmt.db');
  return configured.startsWith('file:') ? configured.slice(5) : configured;
})();

fs.mkdirSync(path.dirname(target), { recursive: true });
const db = new Database(target);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const migrationsDir = path.join(process.cwd(), 'drizzle');
if (!fs.existsSync(migrationsDir)) {
  console.error(
    'No drizzle/ directory found. Run `pnpm exec drizzle-kit generate` first to\n' +
      'produce the SQL from src/lib/db/schema.ts.',
  );
  process.exit(1);
}

const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

db.exec(`CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
const applied = new Set(
  (db.prepare('SELECT name FROM __migrations').all() as Array<{ name: string }>).map((r) => r.name),
);

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  // Drizzle separates statements with its own breakpoint marker.
  const statements = sql
    .split(/--> statement-breakpoint/)
    .map((s) => s.trim())
    .filter(Boolean);

  db.transaction(() => {
    for (const statement of statements) db.exec(statement);
    db.prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
  })();
  console.log(`applied ${file}`);
  count += 1;
}

/**
 * Append-only enforcement.
 *
 * The audit log is the record of what the bot asked for and what a human
 * decided. Application code that can rewrite it is not an audit log, so the
 * prohibition lives in the database where no route handler can bypass it.
 */
db.exec(`
  DROP TRIGGER IF EXISTS audit_log_no_update;
  CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted');
  END;

  DROP TRIGGER IF EXISTS audit_log_no_delete;
  CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not permitted');
  END;
`);

// The gateway lock is a single row; make that structurally true.
db.exec(`
  INSERT OR IGNORE INTO gateway_state (id, locked, updated_at)
  VALUES (1, 0, ${Date.now()});
`);

console.log(
  count === 0
    ? 'schema already up to date; append-only triggers reinstalled'
    : `${count} migration(s) applied; append-only triggers installed`,
);
db.close();
