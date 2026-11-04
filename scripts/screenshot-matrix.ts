/**
 * Capture a comparison matrix with the screenshot fixture, and only trust a
 * comparison once repeat captures of the same build match. Each cell is captured
 * twice from fresh fixtures; a cell that differs from itself is reported as not
 * repeatable and never compared with the baseline.
 *
 *   npm run build -w web &&
 *   npm run screenshot:matrix -- scripts/matrices/site.json --out-dir .crane/screenshots/before
 *
 *   # Then on the changed build:
 *   npm run build -w web &&
 *   npm run screenshot:matrix -- scripts/matrices/site.json --out-dir .crane/screenshots/after --baseline .crane/screenshots/before
 *
 *   npm run screenshot:matrix -- --inspect .crane/screenshots/after/site-1280x800.png
 *
 * Exits 1 when a cell isn't repeatable, can't be compared, or fails to capture.
 * Differences from the baseline are results, not failures, so they exit 0.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { matrixCells, parseMatrix, type MatrixCell } from "./fixture/matrix.ts";
import { diffPngs, readPng, readPngMetadata, type PngDiff } from "./fixture/png.ts";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

interface Options {
  matrix: string | null;
  outDir: string | null;
  baseline: string | null;
  inspect: string | null;
}

function parseArgs(args: string[]): Options {
  const options: Options = { matrix: null, outDir: null, baseline: null, inspect: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out-dir") options.outDir = resolve(args[++i] ?? "");
    else if (a === "--baseline") options.baseline = resolve(args[++i] ?? "");
    else if (a === "--inspect") options.inspect = resolve(args[++i] ?? "");
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else options.matrix = resolve(a);
  }
  return options;
}

function capture(cell: MatrixCell, file: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/screenshot.ts", ...cell.args, "--out", file], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error(`Capture failed (exit ${result.status ?? result.signal}): ${cell.file}`);
}

const diffFiles = (a: string, b: string): PngDiff => diffPngs(readPng(readFileSync(a)), readPng(readFileSync(b)));

function describe(diff: PngDiff): string {
  if (!diff.sameSize) return "the image sizes differ";
  if (!diff.box) return "no differing pixels";
  const { x, y, width, height } = diff.box;
  return `${diff.differing} differing pixels in a ${width}x${height} box at ${x},${y}`;
}

/** Why two images can't be compared, or null when both used the same fixture and framing. */
export function incomparable(a: unknown, b: unknown): string | null {
  const meta = (m: unknown) => (m ?? {}) as { fixture?: unknown; capture?: unknown };
  if (!a || !b) return "one image has no fixture metadata";
  if (JSON.stringify(meta(a).fixture) !== JSON.stringify(meta(b).fixture)) return "they use different fixture versions";
  if (JSON.stringify(meta(a).capture) !== JSON.stringify(meta(b).capture)) return "they are framed differently";
  return null;
}

function compareWithBaseline(file: string, baseline: string): { line: string; comparable: boolean } {
  if (!existsSync(baseline)) return { line: `not comparable: no baseline at ${baseline}`, comparable: false };
  const why = incomparable(readPngMetadata(readFileSync(file)), readPngMetadata(readFileSync(baseline)));
  if (why) return { line: `not comparable: ${why}`, comparable: false };
  return { line: `baseline: ${describe(diffFiles(file, baseline))}`, comparable: true };
}

/** Capture one cell twice, then compare it with the baseline if it's repeatable. True when it can be trusted. */
function runCell(cell: MatrixCell, outDir: string, baselineDir: string | null): boolean {
  const file = join(outDir, cell.file);
  const repeat = join(outDir, "repeat", cell.file);
  capture(cell, file);
  capture(cell, repeat);
  const self = diffFiles(file, repeat);
  if (self.differing) {
    console.log(`${cell.file}: not repeatable, ${describe(self)}. Don't interpret differences from this cell.`);
    return false;
  }
  if (!baselineDir) {
    console.log(`${cell.file}: repeatable`);
    return true;
  }
  const { line, comparable } = compareWithBaseline(file, join(baselineDir, cell.file));
  console.log(`${cell.file}: repeatable, ${line}`);
  return comparable;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.inspect) {
    console.log(JSON.stringify(readPngMetadata(readFileSync(options.inspect)), null, 2));
    return;
  }
  if (!options.matrix || !options.outDir) throw new Error("Usage: screenshot:matrix <matrix.json> --out-dir <dir> [--baseline <dir>]");
  const cells = matrixCells(parseMatrix(readFileSync(options.matrix, "utf8")));
  let trusted = true;
  for (const cell of cells) trusted = runCell(cell, options.outDir, options.baseline) && trusted;
  if (!trusted) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, "scripts/screenshot-matrix.ts")) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
