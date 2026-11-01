import { createContext, useContext } from "react";
import type { Overview } from "./api";

/** App-wide state that App provides and every page reads. Lives here so pages never import App. */
export interface AppCtx {
  overview: Overview | null;
  refresh: () => void;
  instruct: (text?: string) => void;
}

export const AppContext = createContext<AppCtx>({ overview: null, refresh: () => {}, instruct: () => {} });
export const useApp = () => useContext(AppContext);
