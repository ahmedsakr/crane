import type { TaskView } from "./task-view";

/** Where a merged task landed, and how to catch up a checkout Crane had to leave alone. */
export function MergedCard({ merged, merge, main }: { merged: boolean; merge: TaskView["merge"]; main: string }) {
  if (!merged || !merge) return null;
  return (
    <div className="card card-pad">
      <h3 className="card-title">Merged into {main}</h3>
      <p style={{ margin: 0, fontSize: 14, color: "var(--ink-2)" }}>
        {merge.commit ? <span className="mono">{merge.commit.slice(0, 8)}</span> : "Already there"}
        {merge.pushedTo ? `, pushed to ${merge.pushedTo}.` : "."}
      </p>
      {merge.checkoutBehind && (
        <>
          <p style={{ margin: "12px 0 6px", fontSize: 14, color: "var(--ink-2)" }}>
            Your checkout had local changes, so Crane left it alone. Catch it up when it's clean:
          </p>
          <p className="mono" style={{ margin: 0, overflowWrap: "anywhere" }}>
            git -C {merge.checkoutBehind} pull --ff-only
          </p>
        </>
      )}
    </div>
  );
}
