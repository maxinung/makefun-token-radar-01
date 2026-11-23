// vendor/makefun-board.ts — dossier builder for the token launch radar.
//
// buildDossier(outputDir, { text_max_bytes }) reads the dashboard/ and
// screenshots/ the program wrote into outputDir and writes outputDir/dossier.json:
// the entry's screenshots (base64, with their names, sizes and hashes) and a
// text of the dashboard's source.
//
// The text opens with a "## Dashboard" block (the file count, the total bytes,
// and every file's path with its size), then a "## Source" block: each text
// file's path, size and line count, and its contents in a fenced block, every
// file in path order. The text holds at most text_max_bytes UTF-8 bytes: every
// file that fits goes in whole; the first that does not goes in up to its last
// complete line that fits, with a line saying how many of its lines are not
// shown; nothing follows it but a last line naming how many whole files and
// bytes were left out. A file whose extension is not one of .html .css .js
// .json .mjs .svg .md .txt is named in the Dashboard block and not shown.
//
// buildDossier refuses an empty screenshots/ directory, a screenshot name it
// cannot carry, a screenshot that is not a whole PNG or JPEG, a screenshot
// past its byte or count cap, a dashboard file that is not a plain regular
// file, and a dossier past 1.5 MiB. It never includes or skips a file past a
// cap. Screenshot limits: 3 or 4 images, at most 512 KiB each, long side at
// most 1440 px and short side at least 800 px.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { createHash } from "node:crypto";

export interface DossierScreenshot {
  name: string;
  bytes: number;
  sha256: string;
  data: string;
}

export interface Dossier {
  screenshots: DossierScreenshot[];
  text: string;
}

const TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".json", ".mjs", ".svg", ".md", ".txt"]);
const MAX_SCREENSHOTS = 4;
const MAX_SCREENSHOT_BYTES = 512 * 1024;
const MAX_SCREENSHOT_LONG_SIDE = 1440;
const MIN_SCREENSHOT_SHORT_SIDE = 800;
const MAX_DOSSIER_BYTES = 1536 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function isPlainName(name: string): boolean {
  if (name.length < 1 || name.length > 128) return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function walkFiles(dir: string, base: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      throw new Error(`refused dashboard path starting with a dot: ${entry.name}`);
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, base, out);
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join("/"));
    } else {
      throw new Error(`refused dashboard entry that is not a plain file: ${entry.name}`);
    }
  }
}

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || !buf.subarray(0, 3).equals(JPEG_MAGIC)) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buf.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function readScreenshot(dir: string, name: string): DossierScreenshot {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg)$/i.test(name)) {
    throw new Error(`refused screenshot name: ${name}`);
  }
  const full = join(dir, name);
  const st = statSync(full);
  if (!st.isFile()) throw new Error(`refused screenshot that is not a file: ${name}`);
  if (st.size > MAX_SCREENSHOT_BYTES) {
    throw new Error(`refused screenshot past 512 KiB: ${name}`);
  }
  const buf = readFileSync(full);
  const dims = pngDimensions(buf) ?? jpegDimensions(buf);
  if (!dims) throw new Error(`refused screenshot that is not a whole PNG or JPEG: ${name}`);
  const longSide = Math.max(dims.width, dims.height);
  const shortSide = Math.min(dims.width, dims.height);
  if (longSide > MAX_SCREENSHOT_LONG_SIDE) {
    throw new Error(`refused screenshot with long side past 1440: ${name}`);
  }
  if (shortSide < MIN_SCREENSHOT_SHORT_SIDE) {
    throw new Error(`refused screenshot with short side below 800: ${name}`);
  }
  return {
    name,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    data: buf.toString("base64"),
  };
}

export function buildDossierText(dashboardDir: string, textMaxBytes: number): string {
  const relPaths: string[] = [];
  walkFiles(dashboardDir, dashboardDir, relPaths);
  relPaths.sort();
  for (const rel of relPaths) {
    for (const part of rel.split("/")) {
      if (!isPlainName(part)) throw new Error(`refused dashboard file name: ${rel}`);
    }
  }
  const files = relPaths.map((rel) => {
    const buf = readFileSync(join(dashboardDir, rel));
    return { rel, size: buf.length, buf };
  });
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  const dashboardBlock =
    "## Dashboard\n" +
    `Files: ${files.length}\n` +
    `Bytes: ${totalBytes}\n` +
    files.map((f) => `- ${f.rel} (${f.size} bytes)`).join("\n") +
    "\n\n## Source\n";

  const textFiles = files.filter((f) => TEXT_EXTENSIONS.has(extname(f.rel).toLowerCase()));
  const parts: string[] = [dashboardBlock];
  let used = utf8Length(dashboardBlock);

  for (let i = 0; i < textFiles.length; i++) {
    const f = textFiles[i];
    const content = f.buf.toString("utf8");
    const rawLines = content.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
    const lines = rawLines;
    const lang = extname(f.rel).toLowerCase().slice(1);
    const header = `### ${f.rel} (${f.size} bytes, ${lines.length} lines)\n\`\`\`${lang}\n`;
    const footer = "```\n";
    const whole = header + content + (content.endsWith("\n") ? "" : "\n") + footer;
    if (used + utf8Length(whole) <= textMaxBytes) {
      parts.push(whole);
      used += utf8Length(whole);
      continue;
    }
    // First file that does not fit: include it up to its last complete line
    // that fits, then a line saying how many lines are not shown, then the
    // fence close, then the last line naming what was left out.
    const rest = textFiles.slice(i + 1);
    const leftFiles = rest.length;
    const leftBytes = rest.reduce((sum, x) => sum + x.size, 0);
    const notShownSuffix = `\n... `;
    const tailLine = `${leftFiles} files and ${leftBytes} bytes left out\n`;
    let partial = header;
    let partialUsed = used + utf8Length(header);
    let shown = 0;
    for (let li = 0; li < lines.length; li++) {
      const lineText = lines[li] + "\n";
      const notShownLine = `... ${lines.length - li - 1} lines not shown\n`;
      const need =
        utf8Length(lineText) +
        utf8Length(notShownLine) +
        utf8Length(footer) +
        utf8Length(tailLine);
      if (partialUsed + need > textMaxBytes && li > 0) break;
      if (partialUsed + need > textMaxBytes && li === 0) {
        // Not even one line fits: keep the header and the counts, cut here.
        break;
      }
      partial += lineText;
      partialUsed += utf8Length(lineText);
      shown = li + 1;
    }
    void notShownSuffix;
    const notShownLine = `... ${lines.length - shown} lines not shown\n`;
    partial += notShownLine + footer + tailLine;
    parts.push(partial);
    return parts.join("");
  }
  return parts.join("");
}

export function buildDossier(outputDir: string, opts: { text_max_bytes: number }): Dossier {
  const dashboardDir = join(outputDir, "dashboard");
  const screenshotsDir = join(outputDir, "screenshots");
  const shotNames = readdirSync(screenshotsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  if (shotNames.length === 0) throw new Error("refused empty screenshots/");
  if (shotNames.length > MAX_SCREENSHOTS) {
    throw new Error(`refused screenshots past count cap: ${shotNames.length}`);
  }
  const screenshots = shotNames.map((n) => readScreenshot(screenshotsDir, n));
  const text = buildDossierText(dashboardDir, opts.text_max_bytes);
  const dossier: Dossier = { screenshots, text };
  const json = JSON.stringify(dossier, null, 2) + "\n";
  if (utf8Length(json) > MAX_DOSSIER_BYTES) {
    throw new Error("refused dossier past 1.5 MiB");
  }
  writeFileSync(join(outputDir, "dossier.json"), json, "utf8");
  return dossier;
}
