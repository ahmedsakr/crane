import { basename } from "node:path";
import { isCommandAccess, type Repo, type RepoTools } from "@crane/contracts";
import type { Store } from "../store.js";
import { shortId } from "../ids.js";
import { toRepo, type Row } from "./rows.js";
import { getSetting, setSetting } from "./settings.js";
import { now } from "./shared.js";

export type NewRepo = { path: string; name?: string; defaultBranch?: string; isFactory?: boolean };

// Repositories, and the tool rules and checks the operator set for each.
export function listRepos(store: Store): Repo[] {
  return (store.db.prepare("SELECT * FROM repos ORDER BY is_factory DESC, name").all() as Row[]).map(toRepo);
}

export function getRepo(store: Store, idOrName: string): Repo | null {
  const r = store.db
    .prepare("SELECT * FROM repos WHERE id = ? OR name = ? OR path = ?")
    .get(idOrName, idOrName, idOrName) as Row | undefined;
  return r ? toRepo(r) : null;
}

export function addRepo(store: Store, input: NewRepo): Repo {
  const existing = getRepo(store, input.path);
  if (existing) return existing;
  const repo: Repo = {
    id: shortId("r", 4),
    name: input.name ?? basename(input.path),
    path: input.path,
    defaultBranch: input.defaultBranch ?? "main",
    isFactory: !!input.isFactory,
    addedAt: now(),
  };
  store.db
    .prepare("INSERT INTO repos(id, name, path, default_branch, is_factory, added_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run(repo.id, repo.name, repo.path, repo.defaultBranch, repo.isFactory ? 1 : 0, repo.addedAt);
  return repo;
}

export function removeRepo(store: Store, id: string) {
  store.db.prepare("DELETE FROM repos WHERE id = ? AND is_factory = 0").run(id);
}

/**
 * The tool rules the operator has allowed, or chosen to keep blocked, for one
 * repo, and which commands its agents may run. Settings saved before command
 * access existed, or holding a value Crane doesn't know, read as `listed`.
 */
export function repoTools(store: Store, repoId: string): RepoTools {
  const raw = getSetting(store, `tools:${repoId}`);
  const parsed = raw ? (JSON.parse(raw) as Partial<Record<keyof RepoTools, unknown>>) : {};
  return {
    allowed: Array.isArray(parsed.allowed) ? parsed.allowed : [],
    keptBlocked: Array.isArray(parsed.keptBlocked) ? parsed.keptBlocked : [],
    commands: isCommandAccess(parsed.commands) ? parsed.commands : "listed",
  };
}

/** Save the parts given; anything left out keeps its saved value. */
export function setRepoTools(store: Store, repoId: string, change: Partial<RepoTools>) {
  const tools = { ...repoTools(store, repoId), ...change };
  setSetting(store, `tools:${repoId}`, JSON.stringify({
    allowed: [...new Set(tools.allowed)],
    keptBlocked: [...new Set(tools.keptBlocked)],
    commands: tools.commands,
  }));
}

export function repoChecks(store: Store, repoId: string): string[] {
  const raw = getSetting(store, `checks:${repoId}`);
  if (raw) return JSON.parse(raw) as string[];
  return getRepo(store, repoId)?.isFactory ? ["npm run typecheck", "npm test"] : [];
}

export function setRepoChecks(store: Store, repoId: string, commands: string[]) {
  setSetting(store, `checks:${repoId}`, JSON.stringify(commands));
}
