import { defineConfig } from 'drizzle-kit';

// Schema-first config for future migration generation.
// The checked-in SQL files in ./drizzle are applied by `npm run db:migrate`.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL?.replace(/^file:/, '') ?? './data/reply-bot.db',
  },
});
