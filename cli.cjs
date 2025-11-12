const { Command } = require("commander");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { enqueue, getCounts, listByState, getJobById, resetDeadToPending } = require("./src/queue/queue");
const { WorkerManager } = require("./src/worker/worker");
const { getDb } = require("./src/db/db.js");

const program = new Command();
program.name("queuectl").description("CLI background job queue").version("1.0.0");

const configPath = path.resolve(process.cwd(), "config.json");
const pidFile = path.resolve(process.cwd(), ".queuectl.pid");

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    const defaultCfg = {
      default_max_retries: 3,
      backoff_base: 2
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
  .command("enqueue")
  .argument("<jobJson>", "Job JSON string")
  .action((jobJson) => {
    let job;
    try {
      job = JSON.parse(jobJson);
    } catch (err) {
      console.error("❌ Invalid JSON. Example: {\"id\":\"job1\",\"command\":\"echo hello\"}");
      process.exit(1);
    }

    const cfg = loadConfig();
    const ts = Date.now();
    const record = {
      id: job.id || uuidv4(),
      command: job.command,
      state: "pending",
      attempts: 0,
      max_retries: job.max_retries || cfg.default_max_retries,
      created_at: ts,
      updated_at: ts,
      next_run: ts,
    };
    enqueue(record);
    console.log(`✅ Enqueued job: ${record.id}`);
  });

program
  .command("worker")
  .option("-c, --count <n>", "number of workers", parseInt, 1)
  .action((opts) => {
    const cfg = loadConfig();
    const pid = process.pid;
    fs.writeFileSync(pidFile, String(pid));
    console.log(`🚀 Workers started (count=${opts.count}) PID=${pid}`);
    const manager = new WorkerManager({ count: opts.count, backoffBase: cfg.backoff_base });

    process.on("SIGINT", async () => {
      console.log("Graceful shutdown...");
      await manager.stop();
      fs.unlinkSync(pidFile);
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

program.command("status").action(() => {
  const states = getCounts();
  console.table(states);
  const running = fs.existsSync(pidFile);
  console.log("Workers:", running ? "Running" : "Stopped");
});

program
  .command("list")
  .option("-s, --state <state>", "state filter", "pending")
  .action((opts) => {
    const jobs = listByState(opts.state);
    if (!jobs.length) {
      console.log("No jobs found");
      return;
    }
    jobs.forEach((j) => console.log(`${j.id} | ${j.state} | attempts=${j.attempts}`));
  });

program.command("dlq-list").action(() => {
  const jobs = listByState("dead");
  if (!jobs.length) {
    console.log("DLQ empty");
    return;
  }
  jobs.forEach((j) => console.log(`${j.id} | ${j.command}`));
});

program
  .command("dlq-retry")
  .argument("<jobId>")
  .action((id) => {
    const job = getJobById(id);
    if (!job) {
      console.log("Job not found");
      return;
    }
    resetDeadToPending(id);
    console.log(`♻️  Job ${id} moved back to pending`);
  });

program.parse(process.argv);
