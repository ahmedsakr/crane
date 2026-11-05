import { useState, type ReactNode } from "react";
import { useApp } from "../lib/app-context";
import { api, driverLabel, type Agent } from "../lib/api";
import { crewChangeText, crewRoster, type CrewInput, type CrewRoster, type Member } from "../lib/crew";
import { plural } from "../lib/format";
import { useDrivers, usePoll, useTick } from "../lib/hooks";
import { useAction } from "../lib/action";
import { Empty } from "../components/Empty";
import { Section } from "../components/Section";
import { MemberSheet } from "../components/MemberSheet";
import { StorageRetention } from "../components/StorageRetention";
import { MemberRow } from "./crew/MemberRow";
import { PostmortemDefaults } from "./crew/PostmortemDefaults";
import { RunsOn } from "./crew/RunsOn";

function CrewSummary({ roster, driver }: { roster: CrewRoster; driver: string }) {
  return (
    <p className="crew-summary">
      <span><strong className="tabular">{roster.working}</strong> working</span>
      <span><strong className="tabular">{roster.free}</strong> free</span>
      <span><strong className="tabular">{roster.onCall.length}</strong> on-call</span>
      <span>New tasks run on <strong>{driver}</strong></span>
    </p>
  );
}

/** Queued work nobody is free to take: offer the one tap that fixes it. */
function ShortHandedNotice({ queued, spare, saving, onActivate }: { queued: number; spare: Member; saving: boolean; onActivate: () => void }) {
  return (
    <div className="notice" role="status">
      <span>
        <strong>{plural(queued, "task")} waiting</strong> and no one is free to take {queued === 1 ? "it" : "them"}.
      </span>
      <button className="btn btn-primary btn-sm notice-action" disabled={saving} onClick={onActivate}>
        Activate {spare.a.name}
      </button>
    </div>
  );
}

function MemberSections({ active, onCall, row }: { active: Member[]; onCall: Member[]; row: (m: Member, compact?: boolean) => ReactNode }) {
  return (
    <>
      <Section id="crew-active" className="crew-section" title={<>Active <span className="count">{active.length}</span></>}>
        {active.length > 0 ? (
          <ul className="rows card crew-list">{active.map((m) => row(m))}</ul>
        ) : (
          <Empty title="No one is active">Activate an on-call member to start taking work.</Empty>
        )}
      </Section>

      {onCall.length > 0 && (
        <Section id="crew-on-call" className="crew-section" title={<>On-call <span className="count">{onCall.length}</span></>}
          aside={<span className="muted crew-section-note">
            {onCall.some((m) => m.a.runsPostmortems) ? "Named members run post-mortems only" : "No new work until you activate them"}
          </span>}>
          <ul className="rows card crew-list crew-bench">{onCall.map((m) => row(m, true))}</ul>
        </Section>
      )}
    </>
  );
}

export function Crew() {
  const { overview: o, refresh } = useApp();
  const { busy: saving, run } = useAction(refresh);
  const [sheet, setSheet] = useState<{ member: string; start: "settings" | "run" } | null>(null);
  const configure = (a: Agent, input: CrewInput) =>
    run(a.id, () => api.configureCrew(a.id, input), () => {
      const text = crewChangeText(a, input);
      return text ? { text } : undefined;
    });
  const { drivers, set } = useDrivers();
  const schedules = usePoll(api.crewSchedules, 10_000);
  useTick();
  if (!o) return null;
  const driver = driverLabel(drivers?.find((d) => d.isDefault)?.name ?? o.factory.driver);
  const schedulesFor = (id: string) => schedules.data?.filter((s) => s.agentId === id) ?? [];
  const roster = crewRoster(o);
  const { spare } = roster;
  const opened = sheet && roster.members.find((m) => m.a.id === sheet.member);

  const row = (m: Member, compact?: boolean) => (
    <MemberRow key={m.a.id} m={m} compact={compact} schedules={schedulesFor(m.a.id)} saving={!!saving}
      configure={(input) => void configure(m.a, input)}
      onOpen={() => setSheet({ member: m.a.id, start: "settings" })}
      onRun={() => setSheet({ member: m.a.id, start: "run" })} />
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Crew</h1>
      </div>
      {o.agents.length > 0 && <CrewSummary roster={roster} driver={driver} />}

      {!o.factory.running && (
        <div className="notice">
          <strong>The factory is off.</strong>
          <span>Run <span className="mono">crane serve</span> to bring the crew in.</span>
        </div>
      )}
      {spare && <ShortHandedNotice queued={roster.queuedForAnyone} spare={spare} saving={!!saving} onActivate={() => void configure(spare.a, { active: true })} />}

      {o.agents.length === 0 ? (
        <div style={{ marginTop: 20 }}>
          <Empty title="No agents yet">
            Start the factory with <span className="mono">crane serve --agents 3</span>.
          </Empty>
        </div>
      ) : <MemberSections active={roster.active} onCall={roster.onCall} row={row} />}

      {drivers && drivers.length > 0 && <RunsOn drivers={drivers} onChange={set} />}
      {drivers && drivers.length > 0 && <PostmortemDefaults drivers={drivers} />}
      <StorageRetention />

      {opened && (
        <MemberSheet key={sheet.member} m={opened} start={sheet.start} drivers={drivers} factoryDriver={driver} saving={!!saving}
          configure={(input) => void configure(opened.a, input)}
          schedules={schedules.data ? schedulesFor(opened.a.id) : null} schedulesError={schedules.error} reloadSchedules={schedules.refresh}
          onClose={() => setSheet(null)} />
      )}
    </>
  );
}
