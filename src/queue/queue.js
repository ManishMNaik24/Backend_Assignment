import { getDb } from "../db/db.js";
import dayjs from "dayjs";

export async function enqueueJob(job) {
  const db = await getDb();
  const now = dayjs().toISOString();
  await db.run(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
    job.id,
    job.command,
    job.max_retries || 3,
    now,
    now
  );
  console.log(`✅ Enqueued job: ${job.id}`);
}

export async function pickPendingJobAtomic(workerId) {
  const db = await getDb();
  const now = dayjs().toISOString();

  await db.run("BEGIN IMMEDIATE");

  try {
    const job = await db.get(
      `SELECT * FROM jobs
       WHERE state='pending' 
       AND (next_run_at IS NULL OR next_run_at <= ?)
       AND (locked_by IS NULL OR locked_at < datetime('now', '-5 minutes'))
       ORDER BY created_at LIMIT 1`,
      now
    );

    if (!job) {
      await db.run("COMMIT");
      return null;
    }

    await db.run(
      `UPDATE jobs
       SET locked_by = ?, locked_at = ?, state = 'running', updated_at = ?
       WHERE id = ?`,
      workerId,
      now,
      now,
      job.id
    );

    await db.run("COMMIT");
    return job;
  } catch (err) {
    await db.run("ROLLBACK");
    throw err;
  }
}

export async function markCompleted(jobId, output) {
  const db = await getDb();
  await db.run(
    `UPDATE jobs
     SET state = 'completed', locked_by = NULL, locked_at = NULL, 
         last_error = ?, updated_at = ?
     WHERE id = ?`,
    output,
    dayjs().toISOString(),
    jobId
  );
}

export async function rescheduleJobToPending(jobId, nextRunTimestamp, error) {
  const db = await getDb();
  const nextRunAt = dayjs(nextRunTimestamp).toISOString();

  await db.run(
    `UPDATE jobs
     SET state = 'pending', attempts = attempts + 1, next_run_at = ?,
         last_error = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
     WHERE id = ?`,
    nextRunAt,
    error,
    dayjs().toISOString(),
    jobId
  );
}

export async function moveToDead(jobId, error) {
  const db = await getDb();
  await db.run(
    `UPDATE jobs
     SET state = 'dead', last_error = ?, locked_by = NULL, 
         locked_at = NULL, updated_at = ?
     WHERE id = ?`,
    error,
    dayjs().toISOString(),
    jobId
  );
}

export async function getCounts() {
  const db = await getDb();
  const rows = await db.all(
    `SELECT state, COUNT(*) as count
     FROM jobs
     GROUP BY state`
  );
  
  const counts = {};
  rows.forEach((row) => {
    counts[row.state] = row.count;
  });
  
  return counts;
}

export async function listJobs(state = "all") {
  const db = await getDb();
  let rows;
  
  if (state === "all") {
    rows = await db.all("SELECT * FROM jobs ORDER BY created_at");
  } else {
    rows = await db.all(
      "SELECT * FROM jobs WHERE state = ? ORDER BY created_at",
      state
    );
  }
  
  if (rows.length === 0) {
    console.log(`No jobs found${state !== "all" ? ` with state: ${state}` : ""}`);
    return;
  }
  
  console.table(rows);
}

export async function getJobById(id) {
  const db = await getDb();
  const job = await db.get("SELECT * FROM jobs WHERE id = ?", id);
  return job;
}

export async function retryDLQ(id) {
  const db = await getDb();
  await db.run(
    `UPDATE jobs
     SET state = 'pending', attempts = 0, next_run_at = NULL, 
         last_error = NULL, locked_by = NULL, locked_at = NULL, updated_at = ?
     WHERE id = ?`,
    dayjs().toISOString(),
    id
  );
  console.log(`🔁 Retried DLQ job: ${id}`);
}