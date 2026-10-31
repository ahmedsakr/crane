import type { Autonomy, MissionKind, Repo } from "../core/types.js";

export interface MissionDraft {
  kind: MissionKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  /** Short reasons for each guess, shown to the operator so they can correct them. */
  why: { kind: string; repo: string; autonomy: string };
}

const MAINTENANCE = [
  "fix",
  "bug",
  "flaky",
  "failing",
  "broken",
  "upgrade",
  "bump",
  "dependenc",
  "deps",
  "vulnerab",
  "security",
  "cve",
  "lint",
  "refactor",
  "clean",
  "slow",
  "perf",
  "crash",
  "error",
  "leak",
  "deprecat",
  "coverage",
  "tech debt",
  "outdated",
];
const FEATURE = ["add", "build", "support", "feature", "implement", "integrat", "new ", "idea", "would be nice", "let users", "allow"];
const FACTORY = /\b(crane|the factory|this factory|yourself|your own)\b/i;
/** Words that only make sense about Crane itself, so they point a mission at the factory repo. */
const FACTORY_VOCAB =
  /\b(missions?|crew|operator|autonomy|freedom levels?|instruct sheet|needs you|the slab|worktrees?|agent drivers?|simulated driver|factory features?)\b/i;
const OBSERVE = /\b(investigate|research|look into|audit|why|explore|find out|figure out|assess|evaluate|review|what would it take|should we)\b/i;
const CHANGE = /\b(fix|implement|build|add|upgrade|bump|refactor|write|create|remove|migrate)\b/i;

function hits(text: string, words: string[]) {
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w)).length;
}

function titleFrom(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? text;
  let t = first.replace(/^(please|can you|could you|i want you to|i'd like you to)\s+/i, "").replace(/[.!?]+$/, "");
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 72 ? t.slice(0, 71).replace(/\s+\S*$/, "") + "…" : t;
}

/**
 * Turn a plain-language instruction into a mission draft. This is deliberately
 * a transparent heuristic: the operator sees each guess with its reason and can
 * change it before anything runs.
 */
export function draftMission(text: string, repos: Repo[], opts: { lastRepoId?: string | null } = {}): MissionDraft {
  const brief = text.trim();
  const factoryRepo = repos.find((r) => r.isFactory) ?? null;
  const targets = repos.filter((r) => !r.isFactory);

  // Which repo?
  let repo: Repo | null = null;
  let repoWhy = "";
  const named = repos
    .filter((r) => new RegExp(`\\b${r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(brief))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const aboutFactory = FACTORY.test(brief);
  const factoryTerm = brief.match(FACTORY_VOCAB)?.[0]?.toLowerCase();
  const last = opts.lastRepoId ? repos.find((r) => r.id === opts.lastRepoId) : undefined;

  if (named && !named.isFactory) {
    repo = named;
    repoWhy = `You mentioned ${named.name}`;
  } else if ((aboutFactory || named?.isFactory) && factoryRepo) {
    repo = factoryRepo;
    repoWhy = "You mentioned Crane itself";
  } else if (factoryTerm && factoryRepo) {
    repo = factoryRepo;
    repoWhy = `“${factoryTerm}” sounds like Crane's own concepts`;
  } else if (last) {
    repo = last;
    repoWhy = "The repo you used last";
  } else if (repos.length === 1) {
    repo = repos[0]!;
    repoWhy = "It's the only repo connected";
  } else {
    // No signal: ask rather than guess. Crane is always a valid choice.
    repoWhy = targets.length ? "Pick the repo to work on" : "Connect a repo, or pick Crane";
  }

  // What kind?
  let kind: MissionKind;
  let kindWhy: string;
  if (repo?.isFactory) {
    kind = "factory_feature";
    kindWhy = "Work on the factory itself";
  } else if (hits(brief, MAINTENANCE) > hits(brief, FEATURE)) {
    kind = "maintenance";
    kindWhy = "Sounds like upkeep: fixing, upgrading, or cleaning up";
  } else {
    kind = "repo_feature";
    kindWhy = "Sounds like something new to build";
  }

  // How much freedom?
  let autonomy: Autonomy = "observe";
  let autonomyWhy = "Investigating first is the safe default";
  if (OBSERVE.test(brief)) {
    autonomy = "observe";
    autonomyWhy = "You asked for research, not changes";
  } else if (CHANGE.test(brief)) {
    autonomy = "propose";
    autonomyWhy = "You asked for a change, so it will wait for your review";
  }

  return {
    kind,
    title: titleFrom(brief) || "Untitled mission",
    brief,
    repoId: repo?.id ?? null,
    autonomy,
    why: { kind: kindWhy, repo: repoWhy, autonomy: autonomyWhy },
  };
}
