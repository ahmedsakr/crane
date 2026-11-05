import type { DiffFile } from "@crane/contracts";
import { FileStat } from "./FileStat";

/** A file from the diff, or before it loads, only the path the agent reported. */
export type ListedFile = DiffFile | { path: string };

function FileRow({ file, current, onChoose }: { file: ListedFile; current: boolean; onChoose?: (path: string) => void }) {
  const body = (
    <>
      <span className="file-path">{file.path}</span>
      {"hunks" in file && <FileStat file={file} />}
    </>
  );
  if (!onChoose) return <span className="file-row">{body}</span>;
  return (
    <button className="file-row" aria-current={current ? "true" : undefined} onClick={() => onChoose(file.path)}>
      {body}
    </button>
  );
}

export function ChangedFiles({ files, currentPath, onChoose }: {
  files: ListedFile[];
  currentPath?: string | null;
  /** Leave out when there's no diff to open. */
  onChoose?: (path: string) => void;
}) {
  return (
    <div className="card card-pad" style={{ paddingBlock: 6 }}>
      <ul className="files">
        {files.map((f) => (
          <li key={f.path}>
            <FileRow file={f} current={currentPath === f.path} onChoose={onChoose} />
          </li>
        ))}
      </ul>
    </div>
  );
}
