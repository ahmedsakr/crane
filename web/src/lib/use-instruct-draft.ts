import { useEffect, useState } from "react";
import { api, type Repo, type TaskDraft } from "./api";
import { mergeDraft, type DraftOverrides } from "./instruct-draft";

const MIN_DRAFT_LENGTH = 4;
const DRAFT_DEBOUNCE_MS = 220;

/** The instruction being typed, the factory's reading of it, and the operator's changes to that reading. */
export function useInstructDraft(initial: string, repos: Repo[]) {
  const [text, setText] = useState(initial);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [overrides, setOverrides] = useState<DraftOverrides>({});

  // Re-read the instruction as the operator types.
  useEffect(() => {
    if (text.trim().length < MIN_DRAFT_LENGTH) return setDraft(null);
    const t = setTimeout(() => api.draft(text).then(setDraft).catch(() => {}), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  const override = (change: DraftOverrides) => setOverrides((o) => ({ ...o, ...change }));
  return { text, setText, final: mergeDraft(draft, overrides, repos), override };
}
