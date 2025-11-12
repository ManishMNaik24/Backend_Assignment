import { Command } from "commander";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import {
  enqueueJob,
  getCounts,
  listJobs,
  getJobById,
  retryDLQ,
} from "./src/queue/queue.js";
import { WorkerManager } from "./src/worker/worker.js";
import { getDb } from "./src/db/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();
program
  .name("queuectl")
  .description("CLI background job queue")
  .version("1.0.0");

const configPath = path.resolve(process.cwd(), "config.json");
const pidFile = path.resolve(process.cwd(), ".queuectl.pid");

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    const defaultCfg = {
      default_max_retries: 3,
      backoff_base: 2,
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultCfg, null, 2));
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

program
  .command("init-db")
  .description("Initialize the database")
  .action(async () => {
    const db = await getDb();
    console.log("✅ Database initialized at:", path.resolve("queue.db"));
    await db.close();
  });

program
  .command("migrate")
  .description("Migrate existing database to latest schema")
  .action(async () => {
    const db = await getDb();
    console.log("🔄 Running migrations...");
    
    const tableInfo = await db.all("PRAGMA table_info(jobs)");
    const hasLockedBy = tableInfo.some(col => col.name === 'locked_by');
    const hasLockedAt = tableInfo.some(col => col.name === 'locked_at');
    
    if (!hasLockedBy) {
      await db.exec("ALTER TABLE jobs ADD COLUMN locked_by TEXT");
      console.log("  ✅ Added locked_by column");
    }
    
    if (!hasLockedAt) {
      await db.exec("ALTER TABLE jobs ADD COLUMN locked_at TEXT");
      console.log("  ✅ Added locked_at column");
    }
    
    if (hasLockedBy && hasLockedAt) {
      console.log("  ℹ️  Database already up to date");
    }
    
    console.log("✅ Migration completed");
    await db.close();
  });

program
  .command("enqueue [jobJson]")
  .description("Enqueue a job")
  .option("-c, --command <command>", "Command to execute")
  .option("-i, --id <id>", "Job ID (optional)")
  .option("-r, --retries <n>", "Max retries", parseInt)
  .action(async (jobJson, opts) => {
    let job;
    
    if (opts.command) {
      job = {
        command: opts.command,
        id: opts.id,
        max_retries: opts.retries,
      };
    }
    else if (jobJson && jobJson.endsWith('.json') && fs.existsSync(jobJson)) {
      try {
        const fileContent = fs.readFileSync(jobJson, 'utf8');
        job = JSON.parse(fileContent);
      } catch (err) {
        console.error('❌ Invalid JSON file:', err.message);
        process.exit(1);
      }
    }
    else if (jobJson) {
      try {
        job = JSON.parse(jobJson);
      } catch (err) {
        console.error(
          '❌ Invalid JSON. Try using flags instead:\n' +
          '  node cli.js enqueue --command "echo hello"\n' +
          'Or use a JSON file:\n' +
          '  node cli.js enqueue job.json'
        );
        process.exit(1);
      }
    } else {
      console.error(
        '❌ Please provide a job. Examples:\n' +
        '  node cli.js enqueue --command "echo hello"\n' +
        '  node cli.js enqueue --command "dir" --retries 5\n' +
        '  node cli.js enqueue job.json'
      );
      process.exit(1);
    }

    if (!job.command) {
      console.error('❌ Job must have a "command" field');
      process.exit(1);
    }

    const cfg = loadConfig();
    const record = {
      id: job.id || uuidv4(),
      command: job.command,
      max_retries: job.max_retries || cfg.default_max_retries,
    };
    await enqueueJob(record);
  });

program
  .command("worker")
  .option("-c, --count <n>", "number of workers", parseInt, 1)
  .action((opts) => {
    const cfg = loadConfig();
    const pid = process.pid;
    fs.writeFileSync(pidFile, String(pid));
    console.log(`🚀 Workers started (count=${opts.count}) PID=${pid}`);
    const manager = new WorkerManager({
      count: opts.count,
      backoffBase: cfg.backoff_base,
    });

    process.on("SIGINT", async () => {
      console.log("Graceful shutdown...");
      await manager.stop();
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("Graceful shutdown...");
      await manager.stop();
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      process.exit(0);
    });

    manager.start();
  });

program.command("worker-stop").action(() => {
  if (!fs.existsSync(pidFile)) {
    console.log("No worker running");
    return;
  }
  const pid = parseInt(fs.readFileSync(pidFile, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
    console.log("🛑 Worker stopped");
    fs.unlinkSync(pidFile);
  } catch {
    console.log("⚠️ Failed to stop worker");
  }
});

program.command("status").action(async () => {
  const states = await getCounts();
  console.table(states);
  const running = fs.existsSync(pidFile);
  console.log("Workers:", running ? "Running" : "Stopped");
});

program
  .command("list")
  .option("-s, --state <state>", "state filter", "all")
  .action(async (opts) => {
    await listJobs(opts.state);
  });

program.command("dlq-list").action(async () => {
  await listJobs("dead");
});

program
  .command("dlq-retry")
  .argument("<jobId>")
  .action(async (id) => {
    const job = await getJobById(id);
    if (!job) {
      console.log("Job not found");
      return;
    }
    await retryDLQ(id);
  });

program.parse(process.argv);