import type { Overview } from "@crane/contracts";
import { dashboardNotice } from "../../lib/shell";
import { useLoadedUi } from "../../lib/use-shell";

function DashboardNotice({ overview }: { overview: Overview | null }) {
  const loadedUi = useLoadedUi(overview);
  const notice = dashboardNotice(overview?.factory, { built: !import.meta.env.DEV, loadedUi });
  if (notice === "reload") {
    return (
      <div className="notice notice-top" role="status">
        <strong>A newer dashboard is ready.</strong>
        <span>Reload to see the latest changes to Crane.</span>
        <button className="btn btn-primary btn-sm notice-action" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  if (notice === "outdated") {
    return (
      <div className="notice notice-top" role="status">
        <strong>This dashboard is out of date.</strong>
        <span>
          Crane rebuilds it after merges. If this stays, run <span className="mono">npm run build -w web</span> in Crane's checkout and reload.
        </span>
      </div>
    );
  }
  return null;
}

/** Tells the operator when what's running is older than what's been built. */
export function BuildNotices({ overview }: { overview: Overview | null }) {
  return (
    <>
      {overview?.factory.factoryOutdated && (
        <div className="notice notice-top" role="status">
          <strong>The factory is running an older build.</strong>
          <span>
            Run <span className="mono">npm run build</span> in Crane's checkout, then restart the factory to load recent backend changes.
          </span>
        </div>
      )}
      <DashboardNotice overview={overview} />
    </>
  );
}
