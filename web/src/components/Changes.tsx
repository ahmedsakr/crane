import { useId, useMemo, useState, type ReactNode } from "react";
import { parseDiff, type DiffFile, type TaskDiff } from "../lib/api";
import { openFileIndex, saveDiffLayout, savedDiffLayout, type DiffLayout } from "../lib/diff-view";
import { ChangedFiles, type ListedFile } from "./diff/ChangedFiles";
import { DiffViewer } from "./diff/DiffViewer";
import { Section } from "./Section";

function useDiffLayout() {
  const [layout, setLayout] = useState<DiffLayout>(savedDiffLayout);
  const pick = (next: DiffLayout) => {
    setLayout(next);
    saveDiffLayout(next);
  };
  return [layout, pick] as const;
}

/** A status line in the section: the diff is loading, failed, or came back empty. */
const SectionNote = ({ children }: { children: ReactNode }) => <p className="muted section-note">{children}</p>;

interface Props {
  title: string;
  /** What to list before the diff loads: the files the agent reported changing. */
  reported?: string[];
  diff: TaskDiff | null;
  error: string | null;
  /** Whether there's a diff to open at all. */
  canOpen: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Said when the diff turns out to touch no files. */
  empty: string;
  note?: ReactNode;
}

/**
 * A task's changed files, and one tap away, its changes one file at a time, inline or
 * before and after side by side. Files listed first, diffs on request.
 */
export function Changes({ title, reported, diff, error, canOpen, open, onOpenChange, empty, note }: Props) {
  const titleId = useId();
  const parsed = useMemo(() => (diff ? parseDiff(diff.diff) : null), [diff]);
  const [selected, setSelected] = useState<string | null>(null);
  const [layout, pickLayout] = useDiffLayout();
  const files: DiffFile[] | null = parsed?.files ?? null;
  const list: ListedFile[] = files ?? (reported ?? []).map((path) => ({ path }));
  const index = files ? openFileIndex(files, selected) : -1;
  const currentPath = files?.[index]?.path;
  const showViewer = open && canOpen && list.length > 0;

  const choose = (path: string) => {
    setSelected(path);
    onOpenChange(true);
  };
  const onChoose = canOpen ? choose : undefined;
  const openPath = open ? currentPath : null;

  const viewer = () => {
    if (!diff) return <SectionNote>{error ? `Couldn't load changes: ${error}` : "Loading changes…"}</SectionNote>;
    if (!files?.length) return <SectionNote>{empty}</SectionNote>;
    return <DiffViewer files={files} index={index} onSelect={setSelected} layout={layout} onLayout={pickLayout} />;
  };

  return (
    <Section
      id={titleId}
      title={<>{title} {list.length > 0 && <span className="count">{list.length}</span>}</>}
      aside={canOpen && list.length > 0 && (
        <button className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => onOpenChange(!open)}>
          {open ? "Hide changes" : "Show changes"}
        </button>
      )}
    >
      {list.length > 0
        ? <ChangedFiles files={list} currentPath={openPath} onChoose={onChoose} />
        : <SectionNote>{empty}</SectionNote>}
      {parsed?.notes.map((n) => <SectionNote key={n}>{n}</SectionNote>)}
      {showViewer && viewer()}
      {list.length > 0 && note}
    </Section>
  );
}
