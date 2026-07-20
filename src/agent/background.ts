// Background job manager for MorpheOS Code
// Long operations auto-background after a configurable timeout

export type BgJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BgJob {
  id: string;
  name: string;
  status: BgJobStatus;
  startedAt: string;
  finishedAt?: string;
  summary: string;
  result?: string;
  error?: string;
}

export class BackgroundManager {
  private jobs = new Map<string, BgJob>();
  private defaultTimeoutMs = 5000; // 5 seconds before auto-backgrounding

  constructor(timeoutMs?: number) {
    if (timeoutMs !== undefined) this.defaultTimeoutMs = timeoutMs;
  }

  // Start a background job. Returns job ID immediately.
  // The work function receives an AbortSignal for cancellation.
  async run(options: {
    name: string;
    work: (signal: AbortSignal) => Promise<{ summary: string; result?: string }>;
    timeoutMs?: number;
  }): Promise<string> {
    const id = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const job: BgJob = {
      id,
      name: options.name,
      status: "running",
      startedAt: new Date().toISOString(),
      summary: `Starting: ${options.name}`,
    };
    this.jobs.set(id, job);

    const controller = new AbortController();
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;

    // Run in background — don't await
    (async () => {
      try {
        const result = await options.work(controller.signal);
        job.status = "completed";
        job.finishedAt = new Date().toISOString();
        job.summary = result.summary;
        job.result = result.result;
      } catch (error) {
        if (controller.signal.aborted) {
          job.status = "cancelled";
        } else {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        }
        job.finishedAt = new Date().toISOString();
        job.summary = job.error ?? "Failed";
      }
    })();

    return id;
  }

  getJob(id: string): BgJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(status?: BgJobStatus): BgJob[] {
    const all = Array.from(this.jobs.values());
    return status ? all.filter(j => j.status === status) : all;
  }

  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    return true;
  }

  runningCount(): number {
    return this.listJobs("running").length;
  }

  completedCount(): number {
    return this.listJobs("completed").length;
  }
}
