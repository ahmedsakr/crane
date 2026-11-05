import { Link } from "react-router-dom";
import { KIND_LABEL, type Analytics } from "@crane/contracts";
import { useApp } from "../../lib/app-context";
import { plural, usd } from "../../lib/format";
import { repoNamer } from "../../lib/overview";
import { Section } from "../../components/Section";
import { Dot } from "../../components/Status";

export function TopTasks({ tasks }: { tasks: Analytics["topTasks"] }) {
  const { overview } = useApp();
  const repoName = repoNamer(overview?.repos);
  if (tasks.length === 0) return null;
  return (
    <Section id="top-tasks" title="Most expensive tasks">
      <ul className="rows card" style={{ padding: "0 16px" }}>
        {tasks.map((t) => (
          <li key={t.id}>
            <Link className="row spend-row" to={`/tasks/${t.id}`}>
              <Dot status={t.status} />
              <span style={{ minWidth: 0 }}>
                <span className="row-title" style={{ display: "block" }}>
                  {t.title}
                </span>
                <span className="row-meta" style={{ display: "block" }}>
                  {[repoName(t.repoId), KIND_LABEL[t.kind], t.runs > 1 ? plural(t.runs, "run") : null].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="spend-row-usd tabular">{usd(t.usd)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
