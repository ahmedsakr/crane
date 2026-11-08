/** The guard deliberately owns this union until command access reaches contracts. */
export interface GuardContext {
  access: "listed" | "most" | "auto";
  profile: "worktree" | "job" | "inspect";
  worktree: string;
  checkout: string;
  defaultBranch: string;
  craneHome: string;
  home: string | null;
  allowed: string[];
}

export type GuardCategory =
  | "deny-list" | "shared-git" | "outside-worktree" | "operator-actions"
  | "agent-config" | "privilege" | "system" | "credentials" | "remote-code"
  | "publish" | "global-install" | "remote-shell";

export interface GuardVerdict {
  decision: "allow" | "deny" | "pass";
  category: GuardCategory | null;
  reason: string;
  rules: string[];
  overridable: boolean;
}

/** Internal scan evidence; a null directory means a relative target cannot be trusted. */
export interface GuardCommand {
  words: string[];
  text: string;
  cwd: string | null;
}
