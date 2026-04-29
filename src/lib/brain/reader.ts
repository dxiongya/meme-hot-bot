import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { config } from "../../config.js";

export interface PageData {
  path: string;             // brain-relative path, e.g. tokens/sol/F1pp...md
  type: string;
  frontmatter: Record<string, unknown>;
  content: string;          // body excluding frontmatter
  raw: string;              // full file contents
}

const TIMELINE_DIVIDER = /^---\s*$/m;

export function brainPath(...segments: string[]): string {
  return resolve(config.brainDir, ...segments);
}

export function brainRelative(absPath: string): string {
  return relative(resolve(config.brainDir), absPath);
}

export async function readPage(brainRelativePath: string): Promise<PageData | null> {
  const abs = brainPath(brainRelativePath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const parsed = matter(raw);
  return {
    path: brainRelativePath,
    type: (parsed.data.type as string) ?? inferTypeFromPath(brainRelativePath),
    frontmatter: parsed.data,
    content: parsed.content,
    raw,
  };
}

export function inferTypeFromPath(p: string): string {
  if (p.startsWith("tokens/")) return "token";
  if (p.startsWith("patterns/")) return "pattern";
  if (p.startsWith("scans/")) return "scan";
  if (p.startsWith("log/")) return "decision";
  return "meta";
}

/**
 * Split a token / pattern entity page into its two sections:
 *   ## Compiled Truth  (above the divider)
 *   ## Timeline        (append-only, below)
 */
export function splitCompiledTimeline(content: string): {
  compiledTruth: string;
  timeline: string;
} {
  // We use the convention: a single line containing only `---` between sections
  // (this is INSIDE the body, distinct from the YAML frontmatter delimiters).
  const idx = content.search(TIMELINE_DIVIDER);
  if (idx < 0) {
    return { compiledTruth: content.trim(), timeline: "" };
  }
  return {
    compiledTruth: content.slice(0, idx).trim(),
    timeline: content.slice(idx).replace(/^---\s*\n?/, "").trim(),
  };
}
