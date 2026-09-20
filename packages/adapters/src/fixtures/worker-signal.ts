import { setTimeout as delay } from "node:timers/promises";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { Pool } from "pg";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "../wakeup.js";

// Run in a child process: real OS signals must not reach the test runner.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const publisher = new GraphileJobPublisher(pool);
const host = new GraphileJobWorkerHost(pool, { concurrency: 1, pollInterval: 25 });
let release!: () => void;
const work = new Promise<void>((resolve) => {
  release = resolve;
});
process.on("message", (message) => {
  if (message === "release") release();
});
const report = (event: string) => process.send?.(event);
const unexpected = async () => {
  throw new Error("Unexpected job in the signal fixture");
};
// Only this task is enqueued in the disposable database.
await host.start({
  "knowledge.process": unexpected,
  "account.delete": unexpected,
  "learning.import": unexpected,
  "learning.refresh": unexpected,
  "learning.process": unexpected,
  "routine.wakeup": unexpected,
  "computer.update": unexpected,
  "computer.sleep": unexpected,
  "computer.control-expire": unexpected,
  "skill.teaching-expire": unexpected,
  "history.compact": unexpected,
  "messaging.deliver": unexpected,
  "customer.poll": unexpected,
  "customer.process": unexpected,
  "cloud_agent.poll": unexpected,
  "run.continue": async () => {
    report("entered");
    await work;
    report("completed");
  },
} satisfies BackgroundJobHandlers);

async function stop() {
  report("stopping");
  await host.stop();
  report("drained");
  // Model asynchronous connector/realtime cleanup after the job host drains.
  // The shared database must remain usable until that cleanup finishes.
  await delay(100);
  await pool.query("SELECT 1");
  await publisher.close();
  await pool.end();
  report("closed");
  process.disconnect?.();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
await publisher.enqueue({ name: "run.continue", payload: { runId: "signal-drain" } });
