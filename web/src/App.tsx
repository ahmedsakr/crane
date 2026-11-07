import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, matchPath, useLocation, useParams } from "react-router-dom";
import { api } from "./lib/api";
import { AppContext } from "./lib/app-context";
import { needsSignIn } from "./lib/auth";
import { usePoll } from "./lib/hooks";
import { authStore, useAuth } from "./lib/use-auth";
import { useInstructSheet } from "./lib/use-shell";
import { ToastProvider } from "./components/ToastProvider";
import { InstructSheet } from "./components/InstructSheet";
import { Mark } from "./components/Mark";
import { BuildNotices } from "./components/shell/BuildNotices";
import { TopBar } from "./components/shell/TopBar";
import { Home } from "./pages/Home";
import { Tasks } from "./pages/Tasks";
import { TaskPage } from "./pages/TaskPage";
import { Repos } from "./pages/Repos";
import { Crew } from "./pages/Crew";
import { Analytics } from "./pages/Analytics";
import { Goals } from "./pages/Goals";
import { GoalPage } from "./pages/GoalPage";
import { SignIn } from "./pages/SignIn";
import { Operators } from "./pages/Operators";
import { Join } from "./pages/Join";

/** Tasks used to be called missions. Keep old links and bookmarks working. */
function LegacyTaskRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/tasks/${id}` : "/tasks"} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/tasks" element={<Tasks />} />
      <Route path="/tasks/:id" element={<TaskPage />} />
      <Route path="/goals" element={<Goals />} />
      <Route path="/goals/:id" element={<GoalPage />} />
      <Route path="/missions" element={<LegacyTaskRedirect />} />
      <Route path="/missions/:id" element={<LegacyTaskRedirect />} />
      <Route path="/repos" element={<Repos />} />
      <Route path="/crew" element={<Crew />} />
      <Route path="/analytics" element={<Analytics />} />
      <Route path="/operators" element={<Operators />} />
    </Routes>
  );
}

function Shell() {
  const { data: overview, refresh } = usePoll(api.overview, 2000);
  const { sheet, instruct, close } = useInstructSheet();

  return (
    <AppContext.Provider value={{ overview, refresh, instruct }}>
      <TopBar overview={overview} refresh={refresh} onInstruct={() => instruct()} />
      <main className="shell">
        <BuildNotices overview={overview} />
        <AppRoutes />
      </main>
      {sheet && overview && (
        <InstructSheet
          repos={overview.repos}
          initial={sheet.text}
          onClose={() => {
            close();
            refresh();
          }}
        />
      )}
    </AppContext.Provider>
  );
}

/**
 * Pages that open without a session, outside the shell: what someone reaches before they can sign in, such as an
 * invite link. They may call only the API's public routes.
 */
const PUBLIC_PAGES: { path: string; element: ReactNode }[] = [{ path: "/join", element: <Join /> }];

/** Until the factory answers there's nothing to show; if it can't, say so and keep asking. */
function Connecting({ error, retry }: { error: string | null; retry: () => void }) {
  useEffect(() => {
    if (!error) return;
    const t = setInterval(retry, 3000);
    return () => clearInterval(t);
  }, [error, retry]);
  if (!error) return null;
  return (
    <main className="sign-in">
      <div className="sign-in-card">
        <Mark size={44} />
        <h1 className="sign-in-title">Can't reach Crane</h1>
        <p className="sign-in-setup">The factory isn't answering. Trying again…</p>
        <p className="sign-in-note muted">{error}</p>
      </div>
    </main>
  );
}

/**
 * The session decides what renders: sign-in when it's required and missing, otherwise the shell. Nothing protected
 * is fetched before then, and the URL is left alone so signing in shows the page that was opened. The shell is keyed
 * by session, so a new sign-in mounts it afresh: polls, streams and images all start over with the new cookie.
 */
function Gate() {
  const { status, error, refresh } = useAuth();
  const { pathname } = useLocation();
  const publicPage = PUBLIC_PAGES.find((p) => matchPath(p.path, pathname));
  // Public links need no session check; an old in-flight check must not overwrite invite acceptance.
  useEffect(() => { if (!publicPage) void refresh(); }, [refresh, publicPage]);
  if (publicPage) return publicPage.element;
  if (!status) return <Connecting error={error} retry={refresh} />;
  if (needsSignIn(status)) return <SignIn status={status} onSignedIn={authStore.set} />;
  return <Shell key={status.session?.id ?? "open"} />;
}

export function App() {
  return (
    <ToastProvider>
      <Gate />
    </ToastProvider>
  );
}
