import { useState } from "react";
import type { GoalListItem } from "@crane/contracts";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { goalListGroups } from "../lib/goal-plan";
import { usePoll } from "../lib/hooks";
import { repoNamer } from "../lib/overview";
import { GoalRow } from "./goals/GoalRow";
import { NewGoalSheet } from "./goals/NewGoalSheet";

/** A titled group of goals. A finished group folds away unless it's all there is. */
function GoalGroup({ title, goals, fold, onlyGroup }: { title: string; goals: GoalListItem[]; fold?: boolean; onlyGroup: boolean }) {
  const { overview } = useApp();
  const repoName = repoNamer(overview?.repos);
  const heading = <h2 className="section-title">{title} <span className="count">{goals.length}</span></h2>;
  const rows = <div className="goal-list">{goals.map((g) => <GoalRow key={g.id} goal={g} repoName={repoName(g.repoId)} />)}</div>;
  if (!fold) return <section className="goal-section">{heading}{rows}</section>;
  return <details className="goal-section goal-group-fold" open={onlyGroup}><summary>{heading}</summary>{rows}</details>;
}

export function Goals() {
  const { data, error, refresh } = usePoll(api.goals);
  const [creating, setCreating] = useState(false);
  const groups = goalListGroups(data ?? []);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Goals</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>New goal</button>
      </div>
      <p className="muted">Set an outcome, refine the plan, then let the crew work through it.</p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data?.length === 0 && (
        <div className="card card-pad">
          <h2 className="card-title">Start with the outcome</h2>
          <p>A research agent discovers the tasks, dependencies and useful refactoring. You can give feedback until the plan is ready.</p>
        </div>
      )}
      {groups.map((group) => <GoalGroup key={group.title} title={group.title} goals={group.goals} fold={group.fold} onlyGroup={groups.length === 1} />)}
      {creating && <NewGoalSheet onClose={() => { setCreating(false); refresh(); }} />}
    </>
  );
}
