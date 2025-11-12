import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";

const dbPath = path.resolve("queue.db");

let dbInstance = null;

export async function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run_at TEXT,
      last_error TEXT,
      locked_by TEXT,
      locked_at TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_state_next_run 
    ON jobs(state, next_run_at);
    
    CREATE INDEX IF NOT EXISTS idx_locked_by 
    ON jobs(locked_by);
  `);

  return dbInstance;
}

export async function closeDb() {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}