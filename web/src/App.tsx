import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { api } from "./lib/api";
import { AppContext } from "./lib/app-context";
import { usePoll } from "./lib/hooks";
import { useInstructSheet } from "./lib/use-shell";
import { ToastProvider } from "./components/ToastProvider";
import { InstructSheet } from "./components/InstructSheet";
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

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
