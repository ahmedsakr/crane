import type { Overview } from "@crane/contracts";
import { useAction } from "../../lib/action";
import { api } from "../../lib/api";
import { factoryPill } from "../../lib/shell";
import { useToast } from "../../lib/toast";

/** The factory's state, and a tap to pause or resume it. */
export function FactoryPill({ overview, refresh }: { overview: Overview | null; refresh: () => void }) {
  const toast = useToast();
  const { run } = useAction(refresh);
  if (!overview) return null;
  const { running, paused } = overview.factory;
  const { label, title, hint, dot } = factoryPill(overview.factory);
  const toggle = () => {
    if (!running) return toast({ text: "Start the factory from a terminal with: crane serve" });
    if (paused) return void run("resume", () => api.resume(), "Resumed. Agents are picking up work.");
    return void run("pause", () => api.pause(), "Paused. Agents finish what they're doing, then wait.");
  };
  return (
    <button className="factory-pill" onClick={toggle} title={title}>
      <span className={`dot ${dot}`} />
      <span>
        {label}
        <span className="label-long muted">{hint}</span>
      </span>
    </button>
  );
}
