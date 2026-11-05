import { Fragment, type CSSProperties } from "react";
import { splitRows, type DiffFile, type DiffHunk, type DiffLine } from "@crane/contracts";
import { fileStatusLabel, filePathLabel, gutterWidth, inlineLineText, noLinesNote, type DiffLayout } from "../../lib/diff-view";
import { FileStat } from "./FileStat";

function Side({ line, n }: { line: DiffLine | null; n: number | null | undefined }) {
  if (!line) return <span className="diff-side diff-side-blank" />;
  return (
    <span className={`diff-side ${line.kind}`}>
      <span className="ln">{n ?? ""}</span>
      <span className="code">{line.text || " "}</span>
    </span>
  );
}

function InlineLines({ hunk }: { hunk: DiffHunk }) {
  return hunk.lines.map((l, j) => (
    <div key={j} className={`diff-line ${l.kind}`}>
      <span className="ln">{l.oldLine ?? ""}</span>
      <span className="ln">{l.newLine ?? ""}</span>
      <span className="code">{inlineLineText(l)}</span>
    </div>
  ));
}

function SplitLines({ hunk }: { hunk: DiffHunk }) {
  return splitRows(hunk).map((r, j) => (
    <div key={j} className="diff-pair">
      <Side line={r.before} n={r.before?.oldLine} />
      <Side line={r.after} n={r.after?.newLine} />
    </div>
  ));
}

function DiffRows({ file, layout }: { file: DiffFile; layout: DiffLayout }) {
  const Lines = layout === "inline" ? InlineLines : SplitLines;
  const style = { "--ln": gutterWidth(file) } as CSSProperties;
  return (
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
            <Lines hunk={h} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function FileDiff({ file, layout }: { file: DiffFile; layout: DiffLayout }) {
  const status = fileStatusLabel(file);
  const note = noLinesNote(file);
  return (
    <>
      <div className="diff-head">
        <span className="diff-path">{filePathLabel(file)}</span>
        {status && <span className="chip">{status}</span>}
        <FileStat file={file} />
      </div>
      {note ? <p className="muted section-note">{note}</p> : <DiffRows file={file} layout={layout} />}
    </>
  );
}
