/** Execution ownership, not an import-derived partition. Keep each root suite here once. */
export interface TestGroup {
  id: string;
  kind: "package" | "backend" | "web" | "integration" | "architecture" | "build";
  /** Nx project names; selection includes each project's transitive dependencies. */
  projects: readonly string[];
  /** Repository scans/build contracts read beyond their imports: select on any change. */
  repositoryWide?: boolean;
  suites: readonly string[];
}

const suites = (...names: string[]) => names.map((name) => `test/${name}.test.ts`);

export const TEST_GROUPS: readonly TestGroup[] = [
  {
    id: "package-contracts", kind: "package", projects: ["@crane/contracts"],
    suites: suites("contract-helpers"),
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
      "command-guard-driver", "command-guard-hook", "crane-cli-access", "inspect-driver-args",
      "shared-helpers", "simulated-refusals",
    ),
  },
  {
    id: "package-diagnostics", kind: "package",
    // The redaction corpus exercises both consumers, including their private sources.
    projects: ["@crane/diagnostics", "@crane/agent-drivers", "@crane/worktree-deps"],
    suites: suites("diagnostics"),
  },
  {
    id: "package-worktree-deps", kind: "package", projects: ["@crane/worktree-deps"],
    suites: suites("deps", "deps-copy", "install-process"),
  },
  {
    id: "backend-runtime", kind: "package", projects: ["@crane/backend-runtime"],
    suites: suites("backend-runtime"),
  },
  {
    id: "storage", kind: "package", projects: ["@crane/storage"],
    suites: suites("fixtures", "merge-queue", "overview", "store-analytics", "store-claims", "store-concurrency", "store-core", "store-runners", "task-summaries"),
  },
  {
    id: "factory-actions", kind: "package", projects: ["@crane/factory"],
    suites: suites("access", "completion", "crew-schedules", "decision-races", "goals", "queue", "retention", "roles", "runner-actions", "scheduling", "task-draft"),
  },
  {
    id: "factory-agents", kind: "package", projects: ["@crane/factory"],
    suites: suites("agent-logs", "auto-mode", "costs", "drivers", "guard-refusals", "limits", "refusal-context", "restart", "task-context", "visual-review-prompts"),
  },
  {
    id: "factory-execution", kind: "package", projects: ["@crane/factory"],
    suites: suites(
      "acceptance-checks", "factory-elapsed", "idle-factory", "live-diff", "merge-fetch-retry",
      "merge-fixes", "merge", "postmortem", "process-trees", "remote-dispatch", "review-checkpoint", "runner-lane",
      "runner-jobs", "storage-diagnostics", "work-run", "worktree-base", "worktrees",
    ),
  },
  {
    id: "storage-agent-evidence", kind: "integration", projects: ["@crane/storage", "@crane/agent-drivers"],
    suites: suites("codex-costs", "command-evidence"),
  },
  {
    id: "storage-check-reports", kind: "integration", projects: ["@crane/storage", "@crane/agent-protocol"],
    suites: suites("checks"),
  },
  {
    id: "http", kind: "package", projects: ["@crane/http-server"],
    suites: suites("api-auth", "api-exposure", "api-operators", "api-routes", "api-runners", "api", "sign-in-limit"),
  },
  {
    id: "http-factory", kind: "integration", projects: ["@crane/http-server"],
    // Exercise the same domain through HTTP and the underlying services.
    suites: suites(
      "api-goals", "api-scheduling", "api-storage", "command-access", "follow-up", "goal-agents",
      "lookouts", "pre-approve", "prerequisites", "remove-repo", "role-runs", "screenshots", "visual-review",
    ),
  },
  {
    id: "cli", kind: "backend", projects: ["backend"],
    suites: suites("cli-next-steps", "cli-operators", "cli", "setup", "start"),
  },
  {
    id: "cli-http", kind: "integration", projects: ["backend", "@crane/http-server"],
    suites: suites("attribution", "auth-docs", "auth-e2e", "serve-address", "serve", "tls-socket", "tls"),
  },
  {
    id: "web", kind: "web", projects: ["@crane/web"],
    suites: suites(
      "home-derived", "instruct-draft", "placement", "poll", "queue-reorder", "site",
      "slab-chart", "task-view", "web-account", "web-auth", "web-blocks", "web-command-access",
      "web-crew", "web-operators", "web-pages", "web-scheduling",
    ),
  },
  {
    id: "web-http", kind: "integration", projects: ["@crane/web", "@crane/http-server"],
    suites: suites("home-site", "web-operator-api"),
  },
  {
    id: "web-policy", kind: "integration", projects: ["@crane/web", "@crane/agent-policy"],
    suites: suites("web-command-policy"),
  },
  {
    id: "architecture", kind: "architecture", projects: [], repositoryWide: true,
    // Filesystem scans include source shape, boundaries, manifests and project discovery.
    suites: suites("boundaries", "code-shape", "contracts", "nx-graph", "test-ownership", "worktree-deps"),
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

/** Narrow suites whose filesystem access has been reviewed along with their local helpers. */
export const AUDITED_FILESYSTEM = new Set([
  // Disposable repo, home, database, install, process or server fixtures.
  ...suites(
    "acceptance-checks", "agent-logs", "api-exposure", "api-runners", "attribution", "auto-mode", "cli", "codex-costs",
    "command-access", "command-evidence", "command-guard-driver", "costs", "crew-schedules", "decision-races",
    "deps", "deps-copy", "drivers", "fixtures", "follow-up", "goals", "limits", "live-diff", "lookouts",
    "merge", "merge-fetch-retry", "merge-fixes", "overview", "postmortem", "prerequisites", "process-trees",
    "queue", "refusal-context", "remote-dispatch", "restart", "retention", "review-checkpoint", "runner-jobs", "scheduling", "screenshots", "serve",
    "store-claims", "store-concurrency", "store-core", "store-runners", "task-context", "tls", "tls-socket", "visual-review",
    "worktree-base", "worktrees",
  ),
  "test/support/auth-e2e.ts",
  "test/support/fake-agents.ts",
  "test/support/fixtures.ts",
  "test/support/remote-fixture.ts",
  "test/support/retention-fixture.ts",
  // The root README and manifest are global inputs.
  ...suites("auth-docs", "setup"),
  // These inspect driver source or built artifacts. Their owners include the drivers project.
  ...suites("check-handle", "command-guard-hook", "guard-refusals"),
  "test/support/imports.ts",
]);
