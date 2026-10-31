import type {
  Agent,
  Autonomy,
  Mission,
  MissionEvent,
  MissionKind,
  MissionStatus,
  NewMission,
  Overview,
  Repo,
} from "../../../src/core/types";

export type { Agent, Autonomy, Mission, MissionEvent, MissionKind, MissionStatus, Overview, Repo };
export { AUTONOMY_LABEL, KIND_LABEL, STATUS_LABEL } from "../../../src/core/types";

export interface MissionDraft extends NewMission {
  why: { kind: string; repo: string; autonomy: string };
}

export interface MissionDetail {
  mission: Mission;
  repo: Repo | null;
  agent: Agent | null;
  events: MissionEvent[];
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const post = <T>(path: string, json: unknown = {}) => req<T>(path, { method: "POST", json });

export const api = {
  overview: () => req<Overview>("/overview"),
  missions: (status?: string) => req<Mission[]>(`/missions${status ? `?status=${status}` : ""}`),
  mission: (id: string) => req<MissionDetail>(`/missions/${id}`),
  diff: (id: string) => req<{ diff: string }>(`/missions/${id}/diff`),
  draft: (text: string) => post<MissionDraft>("/instruct/draft", { text }),
  createMission: (m: NewMission) => post<Mission>("/missions", m),
  approve: (id: string, note?: string) => post<Mission>(`/missions/${id}/approve`, { note }),
  reject: (id: string, note?: string) => post<Mission>(`/missions/${id}/reject`, { note }),
  cancel: (id: string) => post<Mission>(`/missions/${id}/cancel`),
  retry: (id: string) => post<Mission>(`/missions/${id}/retry`),
  followUp: (id: string, finding: number) => post<Mission>(`/missions/${id}/follow-up`, { finding }),
  repos: () => req<Repo[]>("/repos"),
  addRepo: (path: string, name?: string) => post<Repo>("/repos", { path, name }),
  removeRepo: (id: string) => req<{ ok: true }>(`/repos/${id}`, { method: "DELETE" }),
  agents: () => req<Agent[]>("/agents"),
  pause: () => post("/factory/pause"),
  resume: () => post("/factory/resume"),
};
