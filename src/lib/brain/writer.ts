import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import matter from "gray-matter";
import { brainPath, readPage, splitCompiledTimeline } from "./reader.js";
import { upsertPageIndex } from "./indexer.js";

export interface WritePageInput {
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

async function writeFileEnsuringDir(absPath: string, body: string) {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, body, "utf8");
}

/** Recursively strip keys whose value is `undefined` so js-yaml never chokes. */
function stripUndefined<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return (v as unknown as unknown[]).map(stripUndefined).filter((x) => x !== undefined) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue;
    out[k] = stripUndefined(val);
  }
  return out as T;
}

export async function writePage(input: WritePageInput): Promise<void> {
  const fm = stripUndefined({ type: input.type, ...input.frontmatter }) as Record<string, unknown>;
  const body = matter.stringify(input.content, fm);
  const abs = brainPath(input.path);
  await writeFileEnsuringDir(abs, body);
  await upsertPageIndex({
    path: input.path,
    type: input.type,
    frontmatter: fm,
    content: input.content,
  });
}

/**
 * Generic compiled-truth + timeline update for an entity page.
 */
export async function updateEntityPage(opts: {
  path: string;
  type: string;
  newCompiledTruth: string;
  timelineEvent: string;
  frontmatterPatch?: Record<string, unknown>;
}): Promise<void> {
  const existing = await readPage(opts.path);
  const now = new Date().toISOString();
  let appearance = 1;
  let timeline = "";

  if (existing) {
    appearance = (Number(existing.frontmatter.appearance_count) || 0) + 1;
    timeline = splitCompiledTimeline(existing.content).timeline;
  }

  const newTimeline = (timeline ? timeline + "\n" : "") + opts.timelineEvent;

  const body =
    `## Compiled Truth\n${opts.newCompiledTruth.trim()}\n\n` +
    `---\n\n` +
    `## Timeline (append-only)\n${newTimeline}\n`;

  await writePage({
    path: opts.path,
    type: opts.type,
    frontmatter: {
      ...(existing?.frontmatter ?? {}),
      ...(opts.frontmatterPatch ?? {}),
      appearance_count: appearance,
      last_seen: now,
    },
    content: body,
  });
}

/** Append one timestamped line to a free-form log page. */
export async function appendLogLine(logPath: string, line: string): Promise<void> {
  const existing = await readPage(logPath);
  const ts = new Date().toISOString();
  const newEntry = `- ${ts}  ${line}`;
  const merged = existing
    ? `${existing.content.trim()}\n${newEntry}\n`
    : `# Log\n\n${newEntry}\n`;
  await writePage({
    path: logPath,
    type: existing?.type ?? "log",
    frontmatter: existing?.frontmatter ?? {},
    content: merged,
  });
}
