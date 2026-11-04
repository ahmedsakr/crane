/**
 * A comparison matrix fixes the framing once for a whole set of captures: one
 * page, one target, one readiness condition and one scroll position, across its
 * sizes and media. Every image in a matrix is then framed the same way, and an
 * ad hoc mix of selectors and scrolling can't reach the comparison.
 */
export interface Matrix {
  name: string;
  path: string;
  /** What each image is cropped to. */
  target: string;
  /** What must exist before capturing. */
  ready: string;
  /** Center an element, which holds across layouts, or set one scroller's scrollTop. */
  scroll: { center: string } | { selector: string; top: number };
  sizes: string[];
  media: { name: string; value: string }[];
}

export interface MatrixCell {
  /** The image's file name, unique within the matrix. */
  file: string;
  /** Arguments for scripts/screenshot.ts, without --out. */
  args: string[];
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function field(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (!nonEmpty(value)) throw new Error(`The matrix needs exactly one ${key}, as a string.`);
  return value;
}

function parseScroll(raw: Record<string, unknown>): Matrix["scroll"] {
  const scroll = raw.scroll as { center?: unknown; selector?: unknown; top?: unknown } | undefined;
  const centers = nonEmpty(scroll?.center);
  const sets = nonEmpty(scroll?.selector) && typeof scroll?.top === "number";
  if (centers === sets) throw new Error('The matrix needs one scroll position, like { "center": ".site" } or { "selector": "html", "top": 0 }.');
  return centers ? { center: scroll!.center as string } : { selector: scroll!.selector as string, top: scroll!.top as number };
}

function scrollArgs(scroll: Matrix["scroll"]): string[] {
  return "center" in scroll ? ["--scroll-to", scroll.center] : ["--scroll", `${scroll.selector}=${scroll.top}`];
}

function parseSizes(raw: Record<string, unknown>): string[] {
  const sizes = raw.sizes;
  if (!Array.isArray(sizes) || !sizes.length || !sizes.every((s) => typeof s === "string" && /^\d+x\d+$/.test(s))) {
    throw new Error('The matrix needs sizes, like ["1280x800", "390x844"].');
  }
  return sizes as string[];
}

/** Media entries look like "prefers-color-scheme=dark". No media means one capture per size. */
function parseMedia(raw: Record<string, unknown>): Matrix["media"] {
  const media = raw.media ?? [];
  if (!Array.isArray(media)) throw new Error('The matrix media should look like ["prefers-color-scheme=dark"].');
  return media.map((entry) => {
    const [name, value] = String(entry).split("=");
    if (!name || !value) throw new Error(`Media should look like prefers-color-scheme=dark, got ${entry}`);
    return { name, value };
  });
}

export function parseMatrix(json: string): Matrix {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    name: field(raw, "name"),
    path: field(raw, "path"),
    target: field(raw, "target"),
    ready: field(raw, "ready"),
    scroll: parseScroll(raw),
    sizes: parseSizes(raw),
    media: parseMedia(raw),
  };
}

/** Every capture the matrix asks for: each size, under each media value. */
export function matrixCells(matrix: Matrix): MatrixCell[] {
  const framing = [matrix.path, "--fixture", "--target", matrix.target, "--wait-for", matrix.ready, ...scrollArgs(matrix.scroll)];
  const media = matrix.media.length ? matrix.media : [null];
  return matrix.sizes.flatMap((size) =>
    media.map((m) => ({
      file: [matrix.name, size, m?.value].filter(Boolean).join("-") + ".png",
      args: [...framing, "--size", size, ...(m ? ["--media", `${m.name}=${m.value}`] : [])],
    })),
  );
}
