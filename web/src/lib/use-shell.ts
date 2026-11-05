import { useCallback, useEffect, useState } from "react";
import type { Overview } from "@crane/contracts";
import { instructFromSearch, isInstructShortcut } from "./shell";

/** The instruct sheet's state, opened by `instruct(text)`, the URL, or the keyboard. */
export function useInstructSheet() {
  const [sheet, setSheet] = useState<{ text: string } | null>(() => instructFromSearch(window.location.search));
  const instruct = useCallback((text = "") => setSheet({ text }), []);
  const close = useCallback(() => setSheet(null), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isInstructShortcut(e, (e.target as HTMLElement).tagName)) return;
      e.preventDefault();
      setSheet({ text: "" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { sheet, instruct, close };
}

/** The dashboard build this page loaded. Undefined until the first overview arrives. */
export function useLoadedUi(overview: Overview | null) {
  const [loadedUi, setLoadedUi] = useState<string | null>();
  useEffect(() => {
    if (overview && loadedUi === undefined) setLoadedUi(overview.factory.uiBuild);
  }, [overview, loadedUi]);
  return loadedUi;
}
