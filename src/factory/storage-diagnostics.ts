import { statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeDiagnosticText } from "@crane/diagnostics";

const STORAGE_ERROR = /\b(?:ENOSPC|SQLITE_FULL)\b|no space left on device|database or disk is full/i;
const MAX_LINE = 8192;
const MAX_EVENTS = 4;

/** Fixed paths only: no recursive scans, shell commands, deletion, or permission changes. */
export async function storageSnapshot(cwd: string): Promise<string> {
  const paths = [...new Set([cwd, tmpdir(), process.env.CRANE_HOME ?? join(homedir(), ".crane")])];
  const rows = await Promise.all(paths.map(async path => {
    const label = sanitizeDiagnosticText(path, 1024).text;
    try {
      const fs = await statfs(path, { bigint: true });
      return `${label}: availableBytes=${fs.bavail * fs.bsize} freeBytes=${fs.bfree * fs.bsize} totalBytes=${fs.blocks * fs.bsize} freeInodes=${fs.ffree} totalInodes=${fs.files}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      return `${label}: unavailable (${sanitizeDiagnosticText(code, 128).text})`;
    }
  }));
  return `Storage free-space snapshot (read-only, at first storage error; not file attribution):\n${rows.join("\n")}`;
}

/** Keep early storage errors even when the check's ordinary log tail rolls over. */
export class StorageDiagnostics {
  private partial = new Map<string, string>();
  private events: string[] = [];
  private snapshot: Promise<string> | undefined;

  constructor(private readonly cwd: string) {}

  collect(stream: string, chunk: string): void {
    const lines = ((this.partial.get(stream) ?? "") + chunk).split(/\r?\n/);
    this.partial.set(stream, lines.pop()!.slice(-MAX_LINE));
    for (const line of lines) this.observe(stream, line);
    // Detect a partial line immediately, before the filesystem can recover.
    const partial = this.partial.get(stream)!;
    if (STORAGE_ERROR.test(partial)) this.snapshot ??= storageSnapshot(this.cwd);
  }

  private observe(stream: string, line: string): void {
    if (!STORAGE_ERROR.test(line)) return;
    this.snapshot ??= storageSnapshot(this.cwd);
    if (this.events.length < MAX_EVENTS) {
      const safe = sanitizeDiagnosticText(line, 2048);
      this.events.push(`[${stream}] ${safe.text}${safe.truncated ? " [truncated]" : ""}`);
    }
  }

  async finish(): Promise<string> {
    for (const [stream, line] of this.partial) this.observe(stream, line);
    if (!this.snapshot) return "";
    return `\nStorage error evidence (first ${MAX_EVENTS} matching lines at most):\n${this.events.join("\n")}\n${await this.snapshot}`;
  }
}
