import { Fragment, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { parseDiff, splitRows, type DiffFile, type DiffLine, type TaskDiff } from "../lib/api";
import { Section } from "./Section";

type Layout = "inline" | "split";
const LAYOUT_KEY = "crane.diffLayout";

function savedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
}

const STATUS: Record<DiffFile["status"], string | null> = { added: "New", deleted: "Deleted", renamed: "Moved", modified: null };
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " ", note: "" };

function Stat({ file }: { file: DiffFile }) {
  if (file.binary) return <span className="file-stat muted">binary</span>;
  return (
    <span className="file-stat tabular" aria-label={`${file.additions} added, ${file.deletions} removed`}>
      <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
    </span>
  );
}

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
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const files = parsed?.files ?? null;
  const list: (DiffFile | { path: string })[] = files ?? (reported ?? []).map((path) => ({ path }));
  // A live diff can drop the open file; fall back to the first.
  const index = files ? Math.max(0, files.findIndex((f) => f.path === selected)) : -1;
  const current = files?.[index] ?? null;

  const choose = (path: string) => {
    setSelected(path);
    onOpenChange(true);
  };
  const pickLayout = (l: Layout) => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // Private windows may refuse; the choice still holds for this page.
    }
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
      {list.length > 0 ? (
        <div className="card card-pad" style={{ paddingBlock: 6 }}>
          <ul className="files">
            {list.map((f) => {
              const body = (
                <>
                  <span className="file-path">{f.path}</span>
                  {"hunks" in f && <Stat file={f} />}
                </>
              );
              return (
                <li key={f.path}>
                  {canOpen ? (
                    <button className="file-row" aria-current={open && current?.path === f.path ? "true" : undefined} onClick={() => choose(f.path)}>
                      {body}
                    </button>
                  ) : (
                    <span className="file-row">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="muted section-note">{empty}</p>
      )}
      {parsed?.notes.map((n) => (
        <p key={n} className="muted section-note">
          {n}
        </p>
      ))}
      {open && canOpen && list.length > 0 && (
        !diff ? (
          <p className="muted section-note">{error ? `Couldn't load changes: ${error}` : "Loading changes…"}</p>
        ) : !files?.length || !current ? (
          <p className="muted section-note">{empty}</p>
        ) : (
          <div className="diff-viewer">
            <div className="diff-bar">
              <div className="diff-nav">
                <button className="btn btn-ghost btn-sm" aria-label="Previous file" title="Previous file" disabled={index === 0}
                  onClick={() => setSelected(files[index - 1]!.path)}>
                  ←
                </button>
                <span className="muted tabular">
                  File {index + 1} of {files.length}
                </span>
                <button className="btn btn-ghost btn-sm" aria-label="Next file" title="Next file" disabled={index === files.length - 1}
                  onClick={() => setSelected(files[index + 1]!.path)}>
                  →
                </button>
              </div>
              <div className="segmented segmented-sm" role="group" aria-label="Layout">
                <button aria-pressed={layout === "inline"} onClick={() => pickLayout("inline")}>
                  Inline
                </button>
                <button aria-pressed={layout === "split"} onClick={() => pickLayout("split")}>
                  Side by side
                </button>
              </div>
            </div>
            <FileDiff key={current.path} file={current} layout={layout} />
          </div>
        )
      )}
      {list.length > 0 && note}
    </Section>
  );
}

function FileDiff({ file, layout }: { file: DiffFile; layout: Layout }) {
  const status = STATUS[file.status];
  const head = (
    <div className="diff-head">
      <span className="diff-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
      {status && <span className="chip">{status}</span>}
      <Stat file={file} />
    </div>
  );
  if (file.binary || !file.hunks.length) {
    return (
      <>
        {head}
        <p className="muted section-note">
          {file.binary ? "A binary file. Its contents aren't shown." : file.status === "renamed" ? "Moved, with its contents unchanged." : "No line changes."}
        </p>
      </>
    );
  }
  // Line numbers get one width per file, so every row's gutter lines up.
  const widest = Math.max(...file.hunks.flatMap((h) => h.lines.map((l) => Math.max(l.oldLine ?? 0, l.newLine ?? 0))));
  const style = { "--ln": `${Math.max(2, String(widest).length)}ch` } as CSSProperties;
  return (
    <>
      {head}
      <div className={`diff diff-${layout}`} role="region" aria-label={`Changes to ${file.path}`} tabIndex={0} style={style}>
        <div className="diff-rows">
          {layout === "split" && (
            <div className="diff-sides" aria-hidden>
              <span>Before</span>
              <span>After</span>
            </div>
          )}
          {file.hunks.map((h, i) => (
            <Fragment key={i}>
              <div className="diff-hunk">{h.header}</div>
              {layout === "inline"
                ? h.lines.map((l, j) => (
                    <div key={j} className={`diff-line ${l.kind}`}>
                      <span className="ln">{l.oldLine ?? ""}</span>
                      <span className="ln">{l.newLine ?? ""}</span>
                      <span className="code">{l.kind === "note" ? l.text : `${SIGN[l.kind]}${l.text}`}</span>
                    </div>
                  ))
                : splitRows(h).map((r, j) => (
                    <div key={j} className="diff-pair">
                      <Side line={r.before} n={r.before?.oldLine} />
                      <Side line={r.after} n={r.after?.newLine} />
                    </div>
                  ))}
            </Fragment>
          ))}
        </div>
      </div>
    </>
  );
}

function Side({ line, n }: { line: DiffLine | null; n: number | null | undefined }) {
  if (!line) return <span className="diff-side diff-side-blank" />;
  return (
    <span className={`diff-side ${line.kind}`}>
      <span className="ln">{n ?? ""}</span>
      <span className="code">{line.text || " "}</span>
    </span>
  );
}
