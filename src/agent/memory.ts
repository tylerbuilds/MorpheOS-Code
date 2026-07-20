// Auto memory for MorpheOS Code
// Agent writes its own learnings to .morpheos/MEMORY.md
// First 200 lines / 25KB load at session start

import fs from "node:fs";
import path from "node:path";

const MEMORY_DIR = ".morpheos";
const MEMORY_FILE = "MEMORY.md";
const MAX_LOAD_LINES = 200;
const MAX_LOAD_BYTES = 25_000;

export interface MemoryTopic {
  name: string;          // e.g. "debugging", "api-conventions"
  content: string;
  updatedAt: string;
}

export class MemoryManager {
  readonly projectRoot: string;
  readonly memoryPath: string;
  readonly topicsDir: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.memoryPath = path.join(projectRoot, MEMORY_DIR, MEMORY_FILE);
    this.topicsDir = path.join(projectRoot, MEMORY_DIR, "topics");
  }

  // Load the memory context for a new session
  loadContext(): string | null {
    try {
      const content = fs.readFileSync(this.memoryPath, "utf8");
      const lines = content.split("\n");
      const head = lines.slice(0, MAX_LOAD_LINES).join("\n");
      // Truncate to byte limit
      if (Buffer.byteLength(head, "utf8") > MAX_LOAD_BYTES) {
        return head.slice(0, MAX_LOAD_BYTES);
      }
      return head || null;
    } catch {
      return null;
    }
  }

  // Load a specific topic file
  loadTopic(topicName: string): string | null {
    const sanitized = sanitizeTopicName(topicName);
    const topicPath = path.join(this.topicsDir, `${sanitized}.md`);
    try {
      return fs.readFileSync(topicPath, "utf8");
    } catch {
      return null;
    }
  }

  // Save a new memory entry (appends to MEMORY.md)
  async saveEntry(entry: string): Promise<void> {
    const dir = path.join(this.projectRoot, MEMORY_DIR);
    fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().slice(0, 19);
    const line = `- [${timestamp}] ${entry}\n`;

    // Prepend to keep recent entries at top
    let existing = "";
    try {
      existing = fs.readFileSync(this.memoryPath, "utf8");
    } catch {
      // File doesn't exist yet
    }

    fs.writeFileSync(this.memoryPath, line + existing, "utf8");
  }

  // Save a topic file
  async saveTopic(name: string, content: string): Promise<void> {
    const dir = this.topicsDir;
    fs.mkdirSync(dir, { recursive: true });

    const sanitized = sanitizeTopicName(name);
    const topicPath = path.join(dir, `${sanitized}.md`);

    const header = `# ${name}\n> Last updated: ${new Date().toISOString().slice(0, 19)}\n\n`;
    fs.writeFileSync(topicPath, header + content, "utf8");
  }

  // List all available topics
  listTopics(): string[] {
    try {
      return fs.readdirSync(this.topicsDir)
        .filter(f => f.endsWith(".md"))
        .map(f => f.replace(".md", ""));
    } catch {
      return [];
    }
  }

  // Check if memory file exists
  exists(): boolean {
    try {
      fs.accessSync(this.memoryPath);
      return true;
    } catch {
      return false;
    }
  }
}

// Sanitize a topic name for use as a filename
function sanitizeTopicName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase()
    .replace(/^-+/, "")   // trim leading hyphens
    .replace(/-+$/, "");  // trim trailing hyphens
}
