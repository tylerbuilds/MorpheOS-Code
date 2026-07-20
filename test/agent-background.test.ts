import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundManager } from "../src/agent/background.js";

test("BackgroundManager creates and tracks jobs", () => {
  const mgr = new BackgroundManager();
  const jobs = mgr.listJobs();
  assert.equal(jobs.length, 0);
  assert.equal(mgr.runningCount(), 0);
  assert.equal(mgr.completedCount(), 0);
});

test("job completes successfully with result", async () => {
  const mgr = new BackgroundManager();
  const id = await mgr.run({
    name: "test-success",
    work: async (_signal) => ({ summary: "All done", result: "output data" }),
  });

  assert.ok(id.startsWith("bg_"));

  // Wait for the background job to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  const job = mgr.getJob(id);
  assert.ok(job);
  assert.equal(job!.status, "completed");
  assert.equal(job!.summary, "All done");
  assert.equal(job!.result, "output data");
  assert.ok(job!.finishedAt);
  assert.equal(job!.error, undefined);

  assert.equal(mgr.runningCount(), 0);
  assert.equal(mgr.completedCount(), 1);
});

test("job fails and captures error", async () => {
  const mgr = new BackgroundManager();
  const id = await mgr.run({
    name: "test-fail",
    work: async (_signal) => {
      throw new Error("Something went wrong");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const job = mgr.getJob(id);
  assert.ok(job);
  assert.equal(job!.status, "failed");
  assert.equal(job!.error, "Something went wrong");
  assert.ok(job!.finishedAt);
});

test("cancel running job", async () => {
  const mgr = new BackgroundManager();
  const id = await mgr.run({
    name: "test-cancel",
    work: async (_signal) => {
      // Long-running work that never completes
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return { summary: "Never reached" };
    },
  });

  // Should be running initially
  let job = mgr.getJob(id);
  assert.ok(job);
  assert.equal(job!.status, "running");

  // Cancel it
  const cancelled = mgr.cancelJob(id);
  assert.equal(cancelled, true);

  job = mgr.getJob(id);
  assert.ok(job);
  assert.equal(job!.status, "cancelled");
  assert.ok(job!.finishedAt);

  // Cancelling again should return false
  assert.equal(mgr.cancelJob(id), false);

  // Cancelling a non-existent job returns false
  assert.equal(mgr.cancelJob("nonexistent"), false);
});

test("list jobs by status", async () => {
  const mgr = new BackgroundManager();

  const id1 = await mgr.run({
    name: "success-job",
    work: async (_signal) => ({ summary: "ok" }),
  });

  const id2 = await mgr.run({
    name: "fail-job",
    work: async (_signal) => {
      throw new Error("boom");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(mgr.listJobs("running").length, 0);
  assert.equal(mgr.listJobs("completed").length, 1);
  assert.equal(mgr.listJobs("failed").length, 1);
  assert.equal(mgr.listJobs().length, 2); // all
});

test("multiple concurrent background jobs", async () => {
  const mgr = new BackgroundManager();

  const ids = await Promise.all([
    mgr.run({ name: "job-a", work: async (_signal) => {
      await new Promise(r => setTimeout(r, 20));
      return { summary: "A done" };
    }}),
    mgr.run({ name: "job-b", work: async (_signal) => {
      await new Promise(r => setTimeout(r, 20));
      return { summary: "B done" };
    }}),
    mgr.run({ name: "job-c", work: async (_signal) => {
      await new Promise(r => setTimeout(r, 20));
      return { summary: "C done" };
    }}),
  ]);

  assert.equal(ids.length, 3);
  assert.equal(mgr.listJobs().length, 3);
  // They should all be "running" immediately after creation
  assert.equal(mgr.runningCount(), 3);

  // Wait for all to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(mgr.runningCount(), 0);
  assert.equal(mgr.completedCount(), 3);
});

test("job timeout handling — work function that exceeds timeout still completes", async () => {
  const mgr = new BackgroundManager(50); // 50ms default timeout
  const id = await mgr.run({
    name: "slow-job",
    timeoutMs: 10,
    work: async (_signal) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { summary: "Eventually done" };
    },
  });

  // Job should still be running after a short wait
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(mgr.getJob(id)!.status, "running");

  // Eventually it completes
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mgr.getJob(id)!.status, "completed");
  assert.equal(mgr.getJob(id)!.summary, "Eventually done");
});

test("running and completed counts", async () => {
  const mgr = new BackgroundManager();

  assert.equal(mgr.runningCount(), 0);
  assert.equal(mgr.completedCount(), 0);

  const id1 = await mgr.run({
    name: "quick",
    work: async (_signal) => {
      await new Promise(r => setTimeout(r, 20));
      return { summary: "fast" };
    },
  });

  assert.equal(mgr.runningCount(), 1);
  assert.equal(mgr.completedCount(), 0);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(mgr.runningCount(), 0);
  assert.equal(mgr.completedCount(), 1);
});

test("getJob returns undefined for unknown id", () => {
  const mgr = new BackgroundManager();
  assert.equal(mgr.getJob("nonexistent"), undefined);
});

test("job summary defaults to error message on failure", async () => {
  const mgr = new BackgroundManager();
  const id = await mgr.run({
    name: "error-summary",
    work: async (_signal) => {
      throw new Error("Catastrophic failure");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const job = mgr.getJob(id);
  assert.ok(job);
  assert.equal(job!.summary, "Catastrophic failure");
});

test("work function receives AbortSignal", async () => {
  const mgr = new BackgroundManager();
  let capturedSignal: AbortSignal | undefined;

  const id = await mgr.run({
    name: "signal-check",
    work: async (signal) => {
      capturedSignal = signal;
      return { summary: "checked" };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(capturedSignal !== undefined);
  const sig: AbortSignal = capturedSignal;
  assert.equal(sig.aborted, false);
  assert.equal(mgr.getJob(id)!.status, "completed");
});
