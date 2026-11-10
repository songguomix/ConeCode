import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { applyMigrations } from './migrate';

export type AppDb = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: AppDb;
  appliedMigrations: string[];
  close: () => void;
}

export function openDatabase(databasePath: string, migrationsDir: string): DatabaseHandle {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const appliedMigrations = applyMigrations(sqlite, migrationsDir);
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    appliedMigrations,
    close: () => sqlite.close(),
  };
}
