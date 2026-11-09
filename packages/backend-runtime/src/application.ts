import { createFactoryBuildCheck, servedDashboard } from "./webbuild.js";

// The application supplies its location before loading the CLI or HTTP API.
// A workspace's compiled location cannot identify the application's build mode.
let identity: { root: string; outdated: () => boolean } | undefined;

export function bindApplication(root: string, compiled: boolean): void {
  if (identity) throw new Error("Application identity is already bound");
  identity = { root, outdated: createFactoryBuildCheck(root, compiled) };
}

function application() {
  if (!identity) throw new Error("Application identity must be bound before using factory services");
  return identity;
}

export function factoryRoot(): string {
  return application().root;
}

export function factoryBuildOutdated(): boolean {
  return application().outdated();
}

export function servedApplicationDashboard() {
  return servedDashboard(application().root);
}
