/** What the app shell derives from the factory's state and from key presses. Pure: no DOM and no React. */
import type { Overview } from "@crane/contracts";

type Factory = Overview["factory"];

export function factoryPill({ running, paused }: Pick<Factory, "running" | "paused">) {
  if (!running) return { label: "Off", title: "The factory is off", hint: "", dot: "" };
  if (paused) return { label: "Paused", title: "Resume the factory", hint: " · resume", dot: "dot-paused" };
  return { label: "Running", title: "Pause the factory", hint: " · pause", dot: "dot-on" };
}

/** Cmd/Ctrl+K anywhere, or a bare N when not typing into a field. */
export function isInstructShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean }, targetTag: string): boolean {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(targetTag);
  return (e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "n" && !typing && !e.metaKey && !e.ctrlKey);
}

/** `/?instruct=...` opens the instruct sheet pre-filled (handy from the CLI or a bookmark). */
export function instructFromSearch(search: string): { text: string } | null {
  const text = new URLSearchParams(search).get("instruct");
  return text !== null ? { text } : null;
}

export type DashboardNotice = "reload" | "outdated" | null;

/**
 * Which dashboard notice to show. Crane may serve a newer build than this page loaded; the
 * dev server always serves fresh source, so only a built dashboard can fall behind. The full
 * build the factory notice asks for rebuilds the dashboard too, so that notice replaces "outdated".
 */
export function dashboardNotice(
  factory: Pick<Factory, "uiBuild" | "uiOutdated" | "factoryOutdated"> | undefined,
  page: { built: boolean; loadedUi: string | null | undefined },
): DashboardNotice {
  if (!page.built || !factory) return null;
  if (page.loadedUi && factory.uiBuild && factory.uiBuild !== page.loadedUi) return "reload";
  return factory.uiOutdated && !factory.factoryOutdated ? "outdated" : null;
}
