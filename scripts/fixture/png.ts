/**
 * Just enough PNG for screenshot comparisons, with no image library: decode
 * Chromium's 8-bit RGB or RGBA output, compare pixels, and carry fixture
 * metadata in a text chunk. The metadata travels inside the file, so it survives
 * Crane copying a screenshot to a task's attachments under a new name.
 */
import { crc32, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const METADATA_KEYWORD = "crane:fixture";
const IHDR_END = SIGNATURE.length + 8 + 13 + 4;

export interface Png {
  width: number;
  height: number;
  /** Width × height RGBA pixels. */
  rgba: Buffer;
}

export interface PngDiff {
  sameSize: boolean;
  /** Pixels with any differing channel; every pixel of the larger image when sizes differ. */
  differing: number;
  /** The smallest rectangle holding every difference, or null when there are none. */
  box: { x: number; y: number; width: number; height: number } | null;
}

function chunks(png: Buffer): { type: string; data: Buffer }[] {
  if (!png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error("Not a PNG");
  const found: { type: string; data: Buffer }[] = [];
  for (let at = SIGNATURE.length; at < png.length;) {
    const length = png.readUInt32BE(at);
    found.push({ type: png.toString("latin1", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return found;
}

/** Undo one row's PNG filter in place, given the row above. */
function unfilter(filter: number, row: Buffer, above: Buffer | null, bytes: number) {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bytes ? row[i - bytes]! : 0;
    const up = above ? above[i]! : 0;
    const corner = above && i >= bytes ? above[i - bytes]! : 0;
    const predictors = [0, left, up, (left + up) >> 1, paeth(left, up, corner)];
    row[i] = (row[i]! + predictors[filter]!) & 255;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function readPng(png: Buffer): Png {
  const all = chunks(png);
  const header = all[0]!.data;
  const [width, height, depth, color, interlace] = [header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[12]];
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error("Expected an 8-bit, non-interlaced RGB or RGBA PNG");
  const bytes = color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(all.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const rgba = Buffer.alloc(width * height * 4, 255);
  const stride = width * bytes;
  let above: Buffer | null = null;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const row = raw.subarray(start + 1, start + 1 + stride);
    unfilter(raw[start]!, row, above, bytes);
    for (let x = 0; x < width; x++) row.copy(rgba, (y * width + x) * 4, x * bytes, x * bytes + bytes);
    above = row;
  }
  return { width, height, rgba };
}

export function diffPngs(a: Png, b: Png): PngDiff {
  if (a.width !== b.width || a.height !== b.height) {
    return { sameSize: false, differing: Math.max(a.width * a.height, b.width * b.height), box: null };
  }
  let differing = 0;
  let [left, top, right, bottom] = [a.width, a.height, -1, -1];
  for (let i = 0; i < a.width * a.height; i++) {
    if (a.rgba.readUInt32LE(i * 4) === b.rgba.readUInt32LE(i * 4)) continue;
    differing++;
    const [x, y] = [i % a.width, Math.floor(i / a.width)];
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { sameSize: true, differing, box: differing ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null };
}

/** The same image with `metadata` as JSON in a text chunk. PNG text is Latin-1, so JSON escapes the rest. */
export function withPngMetadata(png: Buffer, metadata: unknown): Buffer {
  const json = JSON.stringify(metadata).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const body = Buffer.concat([Buffer.from("tEXt", "latin1"), Buffer.from(`${METADATA_KEYWORD}\0${json}`, "latin1")]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([png.subarray(0, IHDR_END), length, body, crc, png.subarray(IHDR_END)]);
}

/** The metadata `withPngMetadata` stored, or null for any other image. */
export function readPngMetadata(png: Buffer): unknown {
  const prefix = `${METADATA_KEYWORD}\0`;
  for (const { type, data } of chunks(png)) {
    if (type !== "tEXt") continue;
    const text = data.toString("latin1");
    if (text.startsWith(prefix)) return JSON.parse(text.slice(prefix.length));
  }
  return null;
}
