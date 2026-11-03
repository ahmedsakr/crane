import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Fixtures {
  roots: string[];
  cleanup: (() => void | Promise<void>)[];
}
const owners = new WeakMap<TestContext, Fixtures>();

function fixtures(t: TestContext): Fixtures {
  const existing = owners.get(t);
  if (existing) return existing;
  const owned: Fixtures = { roots: [], cleanup: [] };
  owners.set(t, owned);
  t.after(async () => {
    // Stop factories, then close stores, before removing any owned roots.
    // Attempt every teardown even if another fails, and surface failures.
    const errors: unknown[] = [];
    for (const cleanup of owned.cleanup.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    for (const root of owned.roots) {
      try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Fixture teardown failed");
  });
  return owned;
}

/** Register ownership immediately, before fixture setup can throw. */
export function temporaryRoot(t: TestContext, prefix: string): string {
  const owned = fixtures(t);
  const root = mkdtempSync(join(tmpdir(), prefix));
  owned.roots.push(root);
  return root;
}

export function onFixtureCleanup(t: TestContext, cleanup: () => void | Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const once = () => pending ??= Promise.resolve().then(cleanup);
  fixtures(t).cleanup.push(once);
  return once;
}

export function testHome(t: TestContext): void {
  const previous = process.env.CRANE_HOME;
  process.env.CRANE_HOME = temporaryRoot(t, "crane-home-");
  onFixtureCleanup(t, () => {
    if (previous === undefined) delete process.env.CRANE_HOME;
    else process.env.CRANE_HOME = previous;
  });
}
