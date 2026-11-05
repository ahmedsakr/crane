import type { DiffFile } from "@crane/contracts";

export function FileStat({ file }: { file: DiffFile }) {
  if (file.binary) return <span className="file-stat muted">binary</span>;
  return (
    <span className="file-stat tabular" aria-label={`${file.additions} added, ${file.deletions} removed`}>
      <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
    </span>
  );
}
