import type { DiffFile } from "@crane/contracts";
import type { DiffLayout } from "../../lib/diff-view";
import { FileDiff } from "./FileDiff";

/** One file's changes at a time, with the way to the next file and the layout choice above them. */
export function DiffViewer({ files, index, onSelect, layout, onLayout }: {
  files: DiffFile[];
  index: number;
  onSelect: (path: string) => void;
  layout: DiffLayout;
  onLayout: (layout: DiffLayout) => void;
}) {
  const current = files[index]!;
  return (
    <div className="diff-viewer">
      <div className="diff-bar">
        <div className="diff-nav">
          <button className="btn btn-ghost btn-sm" aria-label="Previous file" title="Previous file" disabled={index === 0}
            onClick={() => onSelect(files[index - 1]!.path)}>
            ←
          </button>
          <span className="muted tabular">
            File {index + 1} of {files.length}
          </span>
          <button className="btn btn-ghost btn-sm" aria-label="Next file" title="Next file" disabled={index === files.length - 1}
            onClick={() => onSelect(files[index + 1]!.path)}>
            →
          </button>
        </div>
        <div className="segmented segmented-sm" role="group" aria-label="Layout">
          <button aria-pressed={layout === "inline"} onClick={() => onLayout("inline")}>
            Inline
          </button>
          <button aria-pressed={layout === "split"} onClick={() => onLayout("split")}>
            Side by side
          </button>
        </div>
      </div>
      <FileDiff key={current.path} file={current} layout={layout} />
    </div>
  );
}
