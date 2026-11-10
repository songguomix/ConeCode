import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from '../config';
import { openDatabase } from './index';
import { Store } from './store';

const command = process.argv[2];
const config = loadConfig(process.env);

if (command !== 'migrate' && command !== 'seed') {
  console.error('Usage: tsx src/server/db/cli.ts <migrate|seed>');
  process.exit(1);
}

const handle = openDatabase(config.databasePath, config.migrationsDir);
try {
  const store = new Store(handle);
  if (handle.appliedMigrations.length > 0) {
    console.log(`Applied migrations: ${handle.appliedMigrations.join(', ')}`);
  } else {
    console.log('Database already up to date.');
  }
  if (command === 'seed') {
    const inserted = store.seedBuiltinTemplates();
    console.log(`Seeded ${inserted} builtin template(s).`);
  }
  console.log(`Database: ${path.resolve(config.databasePath)}`);
} finally {
  handle.close();
}
