import { api } from "./api";
import { useApp } from "./app-context";
import { usePoll } from "./hooks";
import { useAuth } from "./use-auth";

const noPreference = async () => ({ runnerId: null, required: false });

export function useRunnerRouting(enabled = true) {
  const { operator } = useAuth();
  const { overview } = useApp();
  const ownerId = enabled ? operator?.id : undefined;
  const { data, error, refresh } = usePoll(ownerId ? api.runnerPreference : noPreference, 10_000, [ownerId]);
  return {
    runners: (overview?.runners ?? []).filter((runner) => runner.ownerId === ownerId),
    preference: data,
    error,
    refresh,
    signedIn: !!ownerId,
  };
}
