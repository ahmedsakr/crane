import { resolve } from "node:path";
import type { Repo } from "@crane/contracts";
import type { Store } from "@crane/storage";
import { factoryRoot } from "../../application.js";
import { inferDefaultBranch, isGitRepo, repoRoot } from "../git.js";

export function needRepo(store: Store, idOrName: string): Repo {
  const r = store.getRepo(idOrName);
  if (!r) throw new Error(`No repo ${idOrName}`);
  return r;
}

/** Make sure Crane's own checkout is registered, so factory tasks have somewhere to work. */
export async function ensureFactoryRepo(store: Store): Promise<Repo | null> {
  const existing = store.listRepos().find((r) => r.isFactory);
  if (existing) return existing;
  const root = factoryRoot();
  if (!(await isGitRepo(root))) return null;
  return store.addRepo({ path: await repoRoot(root), name: "crane", defaultBranch: await inferDefaultBranch(root), isFactory: true });
}

export async function connectRepo(store: Store, path: string, name?: string): Promise<Repo> {
  const abs = resolve(path);
  if (!(await isGitRepo(abs))) throw new Error(`${abs} is not a git repository`);
  const root = await repoRoot(abs);
  return store.addRepo({ path: root, name, defaultBranch: await inferDefaultBranch(root) });
}

/** Disconnect a repo by id. The factory's own repo stays connected, and an unknown id changes nothing. */
export function removeRepo(store: Store, id: string): void {
  store.removeRepo(id);
}

/**
 * Replace the commands a repo's work must pass before review and merge. Saving
 * none is allowed, and stops that work passing either gate. Bad input leaves the
 * saved checks alone. Resolves the repo first because checks are stored by id.
 */
export function configureChecks(store: Store, repoId: string, input: unknown): string[] {
  const repo = needRepo(store, repoId);
  if (!Array.isArray(input) || input.some((c) => typeof c !== "string" || !c.trim())) {
    throw new Error("Expected an array of nonempty commands");
  }
  const commands = input.map((c: string) => c.trim());
  store.setRepoChecks(repo.id, commands);
  return commands;
}
