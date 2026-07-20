// Checkpoint manager for MorpheOS Code
// Auto-snapshot files before agent mutations

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CHECKPOINT_DIR = ".morpheos/checkpoints";

export interface Checkpoint {
  id: string;
  filePath: string;        // Absolute path of the original file
  timestamp: string;
  content: string;          // Snapshot of file content before edit
  toolCall: string;         // Which tool triggered the checkpoint
  summary: string;          // Human-readable description
}

export class CheckpointManager {
  readonly root: string;
  private checkpoints: Checkpoint[] = [];

  constructor(projectRoot: string) {
    this.root = projectRoot;
  }

  // Snapshot a file before it gets mutated
  snapshot(filePath: string, toolCall: string, summary: string): Checkpoint | null {
    try {
      if (!fs.existsSync(filePath)) return null; // File doesn't exist yet (will be created)

      const content = fs.readFileSync(filePath, "utf8");
      const id = `ck_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;

      const checkpoint: Checkpoint = {
        id,
        filePath: path.resolve(filePath),
        timestamp: new Date().toISOString(),
        content,
        toolCall,
        summary,
      };

      // Persist to disk
      this.saveToDisk(checkpoint);

      // Keep in memory (most recent 50)
      this.checkpoints.unshift(checkpoint);
      if (this.checkpoints.length > 50) this.checkpoints.pop();

      return checkpoint;
    } catch {
      return null;
    }
  }

  // Restore a file from a checkpoint
  restore(checkpointId: string): boolean {
    const ck = this.findCheckpoint(checkpointId);
    if (!ck) return false;

    try {
      fs.writeFileSync(ck.filePath, ck.content, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  // Undo the most recent checkpoint for a specific file
  undo(filePath?: string): Checkpoint | null {
    const resolved = filePath ? path.resolve(filePath) : undefined;
    const ck = resolved
      ? this.checkpoints.find((c) => c.filePath === resolved)
      : this.checkpoints[0];

    if (!ck) return null;

    // Try to restore current state as redo point
    try {
      const currentContent = fs.readFileSync(ck.filePath, "utf8");
      // Save reverse checkpoint for redo
      const redoCk: Checkpoint = {
        id: `redo_${ck.id}`,
        filePath: ck.filePath,
        timestamp: new Date().toISOString(),
        content: currentContent,
        toolCall: "undo",
        summary: `Redo point for: ${ck.summary}`,
      };
      this.saveToDisk(redoCk);
    } catch {
      // Can't create redo point — still proceed with undo
    }

    this.restore(ck.id);
    return ck;
  }

  // List recent checkpoints
  list(limit = 20): Checkpoint[] {
    return this.checkpoints.slice(0, limit);
  }

  // Find a specific checkpoint
  findCheckpoint(id: string): Checkpoint | undefined {
    // Check memory first
    const mem = this.checkpoints.find((c) => c.id === id);
    if (mem) return mem;

    // Check disk
    return this.loadFromDisk(id);
  }

  // Count checkpoints
  count(): number {
    return this.checkpoints.length;
  }

  private saveToDisk(ck: Checkpoint): void {
    const dir = path.join(this.root, CHECKPOINT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${ck.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(ck, null, 2), "utf8");
  }

  private loadFromDisk(id: string): Checkpoint | undefined {
    const filePath = path.join(this.root, CHECKPOINT_DIR, `${id}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return undefined;
    }
  }
}
