/** What the repos page derives from its inputs. Pure: no DOM and no React. */
import type { Repo } from "@crane/contracts";

/** One shell command per line; blank lines don't count. */
export function parseCheckCommands(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Mentioned on a repo's row only when there are some. */
export function openTasksNote(openTasks: number | undefined): string {
  return openTasks ? ` · ${openTasks} open` : "";
}

/** The instruction a repo's New task button starts from. */
export function newTaskInstruction(repo: Pick<Repo, "isFactory" | "name">): string {
  return repo.isFactory
    ? "Research what Crane should build next to need me less"
    : `Investigate open maintenance work in ${repo.name}`;
}
