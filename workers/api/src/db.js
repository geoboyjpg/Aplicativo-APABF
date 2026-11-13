import { neon } from '@neondatabase/serverless';

export function createDatabase(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured.');
  }

  return neon(connectionString);
}
