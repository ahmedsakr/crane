import type { Store } from "./store.js";
import { pruneOrphanScreenshots } from "./screenshots.js";

const HOUR = 3_600_000;

/** Factory-owned, opt-in maintenance; ordinary store opens never delete history. */
export class StorageMaintenance {
  private lastAttempt = -Infinity;
  private lastDays: number | null = null;

  constructor(private store: Store, private log: (message: string) => void) {}

  tick(now = Date.now()): void {
    const days = this.store.retentionSettings().finishedTaskDays;
    const changed = days !== this.lastDays;
    this.lastDays = days;
    if (days === null || (!changed && now - this.lastAttempt < HOUR)) return;
    this.lastAttempt = now;
    try {
      const cutoff = new Date(now - days * 86_400_000).toISOString();
      const events = this.store.pruneTaskHistory(cutoff, days);
      const images = pruneOrphanScreenshots(this.store, now);
      this.store.vacuumHistory();
      if (events || images) this.log(`Storage retention removed ${events} routine events and ${images} unreferenced screenshots`);
    } catch (err) {
      this.log(`Storage retention failed: ${(err as Error).message}. Will retry in an hour`);
    }
  }
}
