import { NavLink } from "react-router-dom";
import type { Overview } from "@crane/contracts";
import { Mark } from "../Mark";
import { AccountMenu } from "./AccountMenu";
import { FactoryPill } from "./FactoryPill";

function NavBadge({ count }: { count: number }) {
  return count > 0 ? <span className="badge">{count}</span> : null;
}

export function TopBar({ overview, refresh, onInstruct }: { overview: Overview | null; refresh: () => void; onInstruct: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <NavLink to="/" className="brand" aria-label="Crane home">
          <Mark />
          crane
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/tasks">
            Tasks
            <NavBadge count={overview?.counts.needs_review ?? 0} />
          </NavLink>
          <NavLink to="/repos">Repos</NavLink>
          <NavLink to="/goals">
            Goals
            <NavBadge count={overview?.goalsNeedingReview?.length ?? 0} />
          </NavLink>
          <NavLink to="/crew">Crew</NavLink>
          <NavLink to="/analytics">Analytics</NavLink>
        </nav>
        <div className="topbar-right">
          <FactoryPill overview={overview} refresh={refresh} />
          <button className="btn btn-primary btn-sm" onClick={onInstruct}>
            Instruct <span className="kbd">⌘K</span>
          </button>
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
