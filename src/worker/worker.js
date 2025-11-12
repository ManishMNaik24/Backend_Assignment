import {
  pickPendingJobAtomic,
  markCompleted,
  rescheduleJobToPending,
  moveToDead,
} from "../queue/queue.js";
import { exec } from "child_process";
import { sleep } from "../utils/common.js";

export class WorkerManager {
  constructor({ count = 1, backoffBase = 2 }) {
    this.count = count;
    this.backoffBase = backoffBase;
    this.stopped = false;
    this.loops = [];
  }

  async start() {
    this.stopped = false;
    for (let i = 0; i < this.count; i++) {
      const id = `worker-${process.pid}-${i}`;
      this.loops.push(this.workerLoop(id));
    }
    await Promise.all(this.loops);
  }

  async stop() {
    this.stopped = true;
    await Promise.all(this.loops);
  }

  async workerLoop(workerId) {
    while (!this.stopped) {
      try {
        const job = await pickPendingJobAtomic(workerId);
        if (!job) {
          await sleep(500);
          continue;
        }
        await this.executeJob(job, workerId);
      } catch (err) {
        console.error(`[${workerId}] unexpected error:`, err);
        await sleep(1000);
      }
    }
  }

  executeJob(job, workerId) {
    return new Promise((resolve) => {
      console.log(`[${workerId}] executing job ${job.id} - ${job.command}`);
      
      const child = exec(job.command, async (error, stdout, stderr) => {
        const output = `stdout:\n${stdout}\nstderr:\n${stderr}\nerror:${
          error ? error.message : "none"
        }`;

        try {
          if (!error) {
            await markCompleted(job.id, output);
            console.log(`[${workerId}] job ${job.id} completed`);
            resolve();
            return;
          }

          const currentAttempts = job.attempts + 1;
          
          if (currentAttempts >= job.max_retries) {
            await moveToDead(job.id, output);
            console.log(`[${workerId}] job ${job.id} moved to DLQ`);
            resolve();
            return;
          }

          const delaySec = Math.pow(this.backoffBase, currentAttempts);
          const nextRun = Date.now() + delaySec * 1000;
          console.log(
            `[${workerId}] job ${job.id} failed (attempt ${currentAttempts}/${job.max_retries}); retrying in ${delaySec}s`
          );
          await rescheduleJobToPending(job.id, nextRun, output);
          resolve();
        } catch (err) {
          console.error(`[${workerId}] error updating job ${job.id}:`, err);
          resolve();
        }
      });
    });
  }
}