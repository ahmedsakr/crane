/** Execution ownership, not an import-derived partition. Keep each root suite here once. */
export interface TestGroup {
  id: string;
  kind: "package" | "backend" | "web" | "architecture" | "build";
  /** Nx project names; selection includes each project's transitive dependencies. */
  projects: readonly string[];
  /** Repository scans/build contracts read beyond their imports: select on any change. */
  repositoryWide?: boolean;
  suites: readonly string[];
}

const suites = (...names: string[]) => names.map((name) => `test/${name}.test.ts`);

export const TEST_GROUPS: readonly TestGroup[] = [
  {
    id: "package-contracts", kind: "package",
    // Shared-helper parity compares contracts, protocol and private driver implementations.
    projects: ["@crane/contracts", "@crane/agent-protocol", "@crane/agent-drivers"],
    suites: suites("shared-helpers"),
  },
  {
    id: "package-agent-protocol", kind: "package", projects: ["@crane/agent-protocol"],
    suites: suites("report"),
  },
  {
    id: "package-agent-policy", kind: "package", projects: ["@crane/agent-policy"],
    suites: suites("agent-policy", "command-guard", "command-guard-inspect"),
  },
  {
    id: "package-agent-drivers", kind: "package", projects: ["@crane/agent-drivers"],
    suites: suites(
      "agent-process", "agent-streams", "check-handle", "claude-evidence",
      "command-guard-driver", "command-guard-hook", "inspect-driver-args",
    ),
  },
  {
    id: "package-diagnostics", kind: "package",
    // The redaction corpus exercises both consumers, including their private sources.
    projects: ["@crane/diagnostics", "@crane/agent-drivers", "@crane/worktree-deps"],
    suites: suites("diagnostics"),
  },
  {
    id: "package-worktree-deps", kind: "package",
    // deps checks backend elapsed formatting; computed export probes conservatively cover all projects.
    projects: ["@crane/worktree-deps", "backend", "@crane/web"],
    suites: suites("deps", "install-process", "worktree-deps"),
  },
  {
    id: "backend", kind: "backend", projects: ["backend", "@crane/web"],
    // Integration suites include web helpers (scheduling and visual review).
    suites: suites(
      "acceptance-checks", "access", "agent-logs", "api-auth", "api-exposure", "api-operators",
      "api-routes", "api", "attribution", "auth-docs", "auth-e2e", "auto-mode", "checks",
      "cli-next-steps", "cli-operators", "cli", "codex-costs", "command-access", "command-evidence",
      "completion", "core", "costs", "crew-schedules", "decision-races", "drivers", "fixtures",
      "follow-up", "goal-agents", "goals", "guard-refusals", "idle-factory", "limits", "live-diff",
      "lookouts", "merge-fetch-retry", "merge-fixes", "merge-queue", "merge", "overview",
      "postmortem", "pre-approve", "prerequisites", "process-trees", "queue", "refusal-context",
      "remove-repo", "restart", "retention", "review-checkpoint", "role-runs", "roles", "scheduling",
      "screenshots", "serve-address", "serve", "setup", "sign-in-limit", "start", "storage-diagnostics",
      "store-analytics", "store-claims", "store-concurrency", "task-context", "task-summaries",
      "tls-socket", "tls", "visual-review-prompts", "visual-review", "work-run", "worktree-base", "worktrees",
    ),
  },
  {
    id: "web", kind: "web", projects: ["@crane/web", "backend"],
    // Home/API and command-access parity tests intentionally import backend/private packages too.
    suites: suites(
      "home-derived", "home-site", "instruct-draft", "placement", "poll", "queue-reorder", "site",
      "slab-chart", "task-view", "web-account", "web-auth", "web-blocks", "web-command-access",
      "web-crew", "web-operator-api", "web-operators", "web-pages",
    ),
  },
  {
    id: "architecture", kind: "architecture", projects: [], repositoryWide: true,
    // Filesystem scans include source shape, boundaries, manifests and project discovery.
    suites: suites("boundaries", "code-shape", "contracts", "nx-graph", "test-ownership"),
  },
  {
    id: "build", kind: "build", projects: [], repositoryWide: true,
    // Build/lifecycle/fixture tests read configs, scripts and trees rather than just imports.
    suites: suites(
      "benchmark-tasks", "build", "dashboard", "screenshot-fixture", "tasks", "tasks-process", "test-runner", "test-runner-process", "webbuild",
      "workspace-links",
    ),
  },
];
