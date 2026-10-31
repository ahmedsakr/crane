import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useParams } from "react-router-dom";
import { api, type Overview } from "./lib/api";
import { usePoll } from "./lib/hooks";
import { Mark, ToastProvider, useToast } from "./components/bits";
import { InstructSheet } from "./components/InstructSheet";
import { Home } from "./pages/Home";
import { Tasks } from "./pages/Tasks";
import { TaskPage } from "./pages/TaskPage";
import { Repos } from "./pages/Repos";
import { Crew } from "./pages/Crew";
import { Analytics } from "./pages/Analytics";

interface AppCtx {
  overview: Overview | null;
  refresh: () => void;
  instruct: (text?: string) => void;
}
/** Tasks used to be called missions. Keep old links and bookmarks working. */
function LegacyTaskRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/tasks/${id}` : "/tasks"} replace />;
}

const Ctx = createContext<AppCtx>({ overview: null, refresh: () => {}, instruct: () => {} });
export const useApp = () => useContext(Ctx);

function FactoryPill({ o, refresh }: { o: Overview | null; refresh: () => void }) {
  const toast = useToast();
  if (!o) return null;
  const { running, paused } = o.factory;
  const label = !running ? "Off" : paused ? "Paused" : "Running";
  const toggle = async () => {
    if (!running) return toast({ text: "Start the factory from a terminal with: crane serve" });
    if (paused) {
      await api.resume();
      toast({ text: "Resumed. Agents are picking up work." });
    } else {
      await api.pause();
      toast({ text: "Paused. Agents finish what they're doing, then wait." });
    }
    refresh();
  };
  return (
    <button
      className="factory-pill"
      onClick={toggle}
      title={running ? (paused ? "Resume the factory" : "Pause the factory") : "The factory is off"}
    >
      <span className={`dot ${!running ? "" : paused ? "dot-paused" : "dot-on"}`} />
      <span>
        {label}
        <span className="label-long muted">
          {running ? (paused ? " · resume" : " · pause") : ""}
        </span>
      </span>
    </button>
  );
}

function Shell() {
  const { data: overview, refresh } = usePoll(api.overview, 2000);
  // `/?instruct=...` opens the instruct sheet pre-filled (handy from the CLI or a bookmark).
  const [sheet, setSheet] = useState<{ text: string } | null>(() => {
    const q = new URLSearchParams(window.location.search).get("instruct");
    return q !== null ? { text: q } : null;
  });
  const instruct = useCallback((text = "") => setSheet({ text }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "n" && !typing && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        setSheet({ text: "" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needs = overview?.counts.needs_review ?? 0;

  return (
    <Ctx.Provider value={{ overview, refresh, instruct }}>
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
              {needs > 0 && <span className="badge">{needs}</span>}
            </NavLink>
            <NavLink to="/repos">Repos</NavLink>
            <NavLink to="/crew">Crew</NavLink>
            <NavLink to="/analytics">Analytics</NavLink>
          </nav>
          <div className="topbar-right">
            <FactoryPill o={overview} refresh={refresh} />
            <button className="btn btn-primary btn-sm" onClick={() => instruct()}>
              Instruct <span className="kbd">⌘K</span>
            </button>
          </div>
        </div>
      </header>
      <main className="shell">
        {/* The dev server always serves fresh source, so only a built dashboard can fall behind. */}
        {overview?.factory.uiOutdated && !import.meta.env.DEV && (
          <div className="notice notice-top" role="status">
            <strong>This dashboard is out of date.</strong>
            <span>
              Recent changes to Crane's UI won't show until you run <span className="mono">npm run build</span> and reload.
            </span>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/missions" element={<LegacyTaskRedirect />} />
          <Route path="/missions/:id" element={<LegacyTaskRedirect />} />
          <Route path="/repos" element={<Repos />} />
          <Route path="/crew" element={<Crew />} />
          <Route path="/analytics" element={<Analytics />} />
        </Routes>
      </main>
      {sheet && overview && (
        <InstructSheet
          repos={overview.repos}
          initial={sheet.text}
          onClose={() => {
            setSheet(null);
            refresh();
          }}
        />
      )}
    </Ctx.Provider>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
