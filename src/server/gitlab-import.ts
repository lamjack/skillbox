import { createHash } from "node:crypto";
import matter from "gray-matter";
import { z } from "zod";
import { inspectSkillPackage } from "../skill-manifest";
import { excludedImportPath, hasEmbeddedSecret } from "../skill-import-safety";
import type { SkillFile, GitLabSource } from "../shared";
import { Problem, safePath, validateFiles, metadata } from "./library";
import { claimImport } from "./import-limit";
import { importBatchTimeoutMs } from "./config";
import {
  gitlabHost,
  importLimitMessage,
  importMaxBytes,
  importMaxFileBytes,
  importMaxFiles,
} from "./config";
import { gitlabImportToken } from "./gitlab-settings";

export const gitlabImportInput = z
  .object({
    url: z.string().min(1).max(2048),
    path: z.string().max(1000).optional(),
  })
  .strict();
const SHA = /^[0-9a-f]{40}$/;
const apiResponseLimit = () => Math.max(4_000_000, importMaxFileBytes());
type Entry = {
  path: string;
  mode: string;
  type: string;
  id: string;
};
type Target = {
  project: string;
  kind: "repo" | "tree" | "blob";
  segments: string[];
};

export function parseGitLabUrl(value: string): Target {
  const host = gitlabHost();
  if (!host) throw new Problem(404, "GitLab import is not configured");
  return parseGitLabUrlOnHost(value, host);
}
export function parseGitLabUrlOnHost(value: string, host: string): Target {
  const raw = /^https:\/\/([^/?#]+)\/([^?#]+)\/?$/.exec(value.trim());
  if (!raw || raw[1] !== host)
    throw new Problem(
      400,
      `Use an https://${host} project, tree, or SKILL.md URL without query parameters`,
    );
  let parts: string[];
  try {
    parts = raw[2].replace(/\/$/, "").split("/").map(decodeURIComponent);
  } catch {
    throw new Problem(400, "Invalid GitLab URL encoding");
  }
  if (
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || /[\\/\x00-\x1f]/.test(part),
    )
  )
    throw new Problem(400, "Invalid GitLab URL path");
  // "-/" separates the project path from GitLab's own routing segments.
  const dash = parts.indexOf("-");
  const projectParts = (dash === -1 ? parts : parts.slice(0, dash)).slice();
  if (projectParts.length < 2)
    throw new Problem(400, "Invalid GitLab project path");
  const project = projectParts
    .map((part, i) =>
      i === projectParts.length - 1 ? part.replace(/\.git$/, "") : part,
    )
    .join("/");
  if (
    projectParts.some(
      (part) => !/^[a-zA-Z0-9_.-]{1,100}$/.test(part) || part.startsWith("."),
    )
  )
    throw new Problem(400, "Invalid GitLab project path");
  if (dash === -1) return { project, kind: "repo", segments: [] };
  const kind = parts[dash + 1];
  const segments = parts.slice(dash + 2);
  if (
    (kind !== "tree" && kind !== "blob") ||
    !segments.length ||
    segments.length > 20
  )
    throw new Problem(400, "Use a project, tree folder, or SKILL.md file URL");
  if (kind === "blob" && segments.at(-1) !== "SKILL.md")
    throw new Problem(400, "File URLs must point to SKILL.md");
  return { project, kind, segments };
}
async function boundedBytes(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Problem(413, "GitLab response exceeds import limits");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Problem(502, "GitLab returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Problem(413, "GitLab response exceeds import limits");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
export async function gitlabFetch(
  host: string,
  path: string,
  signal: AbortSignal,
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": "Skillbox",
    ...(token ? { "PRIVATE-TOKEN": token } : {}),
  };
  return fetch(`https://${host}${path}`, {
    headers,
    redirect: "error",
    signal,
  });
}
export async function gitlabJson(
  host: string,
  path: string,
  signal: AbortSignal,
  token: string | null,
  missing = false,
): Promise<any> {
  const response = await gitlabFetch(host, path, signal, token);
  if ((response.status === 404 || response.status === 422) && missing) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new Problem(
        502,
        "GitLab rejected the configured token; it needs read_api and read_repository",
      );
    if (response.status === 429)
      throw new Problem(429, "GitLab API limit reached; try again later");
    if (response.status === 404)
      throw new Problem(404, "GitLab project or ref not found");
    throw new Problem(502, "GitLab request failed");
  }
  return JSON.parse(
    (await boundedBytes(response, apiResponseLimit())).toString("utf8"),
  );
}
const sourceUrl = (
  host: string,
  project: string,
  commit: string,
  path: string,
) =>
  `https://${host}/${project}/-/tree/${commit}${path ? "/" + encodeURIComponent(path).replace(/%2F/g, "/") : ""}`;
async function resolveTarget(
  host: string,
  target: Target,
  signal: AbortSignal,
  token: string | null,
) {
  const base = `/api/v4/projects/${encodeURIComponent(target.project)}`;
  let commit: any,
    path = "",
    ref = "";
  if (target.kind === "repo") {
    const project = await gitlabJson(host, base, signal, token);
    if (typeof project.default_branch !== "string" || !project.default_branch)
      throw new Problem(400, "Project has no default branch");
    commit = await gitlabJson(
      host,
      `${base}/repository/commits/${encodeURIComponent(project.default_branch)}`,
      signal,
      token,
    );
    ref = project.default_branch;
  } else {
    // Branch names can contain slashes; resolve the longest matching ref
    // prefix first, with a fixed request bound.
    const max = SHA.test(target.segments[0])
      ? 1
      : Math.min(target.segments.length - (target.kind === "blob" ? 1 : 0), 12);
    for (let count = max; count >= 1; count--) {
      commit = await gitlabJson(
        host,
        `${base}/repository/commits/${encodeURIComponent(target.segments.slice(0, count).join("/"))}`,
        signal,
        token,
        true,
      );
      if (commit) {
        ref = target.segments.slice(0, count).join("/");
        path = target.segments.slice(count).join("/");
        break;
      }
    }
    if (!commit)
      throw new Problem(
        404,
        "GitLab project or ref not found; use a full commit SHA for long branch names",
      );
    if (target.kind === "blob")
      path = path === "SKILL.md" ? "" : path.replace(/\/SKILL\.md$/, "");
  }
  if (!SHA.test(commit?.id))
    throw new Problem(502, "Invalid GitLab commit response");
  if (SHA.test(target.segments[0] ?? "") && commit.id !== target.segments[0])
    throw new Problem(502, "GitLab returned a different commit than requested");
  const entries: Entry[] = [];
  for (let page = 1; ; page++) {
    const response = await gitlabFetch(
      host,
      `${base}/repository/tree?ref=${encodeURIComponent(commit.id)}&path=${encodeURIComponent(path)}&recursive=true&per_page=100&page=${page}`,
      signal,
      token,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Problem(502, "GitLab tree request failed");
    }
    const chunk = JSON.parse(
      (await boundedBytes(response, apiResponseLimit())).toString("utf8"),
    );
    if (!Array.isArray(chunk))
      throw new Problem(502, "Invalid GitLab tree response");
    entries.push(...chunk);
    if (entries.length > 10_000)
      throw new Problem(413, "Repository tree is too large for URL import");
    const next = response.headers.get("x-next-page");
    if (!next || Number(next) !== page + 1) break;
  }
  if (
    entries.some(
      (entry: Entry) =>
        typeof entry.path !== "string" ||
        entry.path.length > 1000 ||
        /[\\\x00-\x1f]/.test(entry.path) ||
        entry.path
          .split("/")
          .some((part) => !part || part === "." || part === ".."),
    )
  )
    throw new Problem(400, "Repository contains an unsafe path");
  return { commit: commit.id as string, ref, path, entries };
}
type Resolved = Awaited<ReturnType<typeof resolveTarget>>;
function under(path: string, root: string) {
  return !root || path === root || path.startsWith(root + "/");
}
function listCandidates(resolved: Resolved) {
  return resolved.entries
    .filter(
      (e) =>
        e.type === "blob" &&
        e.path.split("/").at(-1) === "SKILL.md" &&
        under(e.path, resolved.path) &&
        !excludedImportPath(e.path),
    )
    .map((e) => (e.path === "SKILL.md" ? "" : e.path.slice(0, -9)))
    .sort();
}

export async function prepareGitLabImport(
  input: z.input<typeof gitlabImportInput>,
  signal?: AbortSignal,
) {
  const args = gitlabImportInput.parse(input);
  const target = parseGitLabUrl(args.url);
  const host = gitlabHost()!;
  const token = await gitlabImportToken();
  const release = claimImport();
  const deadline = AbortSignal.timeout(importBatchTimeoutMs());
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const base = `/api/v4/projects/${encodeURIComponent(target.project)}`;
  try {
    const resolved = await resolveTarget(host, target, combined, token);
    const candidates = listCandidates(resolved);
    if (!candidates.length)
      throw new Problem(400, "No SKILL.md found in this project or folder");
    if (candidates.length > 100)
      throw new Problem(413, "Too many skills; use a URL for a smaller folder");
    let selected = args.path;
    if (selected === undefined && candidates.includes(resolved.path))
      selected = resolved.path;
    if (selected === undefined && candidates.length === 1)
      selected = candidates[0];
    if (selected === undefined)
      return {
        kind: "catalog" as const,
        url: sourceUrl(host, target.project, resolved.commit, resolved.path),
        commit: resolved.commit,
        candidates,
      };
    if (!candidates.includes(selected))
      throw new Problem(
        400,
        "Choose a skill directory from this project or folder",
      );
    return assembleGitLabSkill(
      host,
      target,
      resolved,
      selected,
      combined,
      token,
    );
  } catch (error) {
    if (error instanceof Problem) throw error;
    if (combined.aborted)
      throw new Problem(408, "GitLab import timed out or was cancelled");
    throw new Problem(502, "GitLab import failed");
  } finally {
    release();
  }
}

export async function assembleGitLabSkill(
  host: string,
  target: Target,
  resolved: Resolved,
  selected: string,
  signal: AbortSignal,
  token: string | null,
) {
  const base = `/api/v4/projects/${encodeURIComponent(target.project)}`;
  const skipped: string[] = [];
  const entries = resolved.entries.filter((e) => {
    if (!under(e.path, selected) || e.type === "tree") return false;
    const relative = selected ? e.path.slice(selected.length + 1) : e.path;
    if (excludedImportPath(relative)) {
      skipped.push(relative);
      return false;
    }
    safePath(relative);
    // mode 120000 is a symlink; 160000/type commit is a submodule.
    if (e.type !== "blob" || !["100644", "100755"].includes(e.mode))
      throw new Problem(
        400,
        `Symlinks and submodules are not supported: ${relative}`,
      );
    if (!SHA.test(e.id))
      throw new Problem(502, `Invalid GitLab file metadata: ${relative}`);
    return true;
  });
  if (!entries.length || entries.length > importMaxFiles())
    throw new Problem(413, importLimitMessage());
  const files: SkillFile[] = new Array(entries.length);
  let next = 0,
    total = 0;
  const cancel = new AbortController();
  const downloads = AbortSignal.any([signal, cancel.signal]);
  let failure: unknown;
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        for (;;) {
          downloads.throwIfAborted();
          const index = next++;
          if (index >= entries.length) return;
          try {
            const entry = entries[index];
            const response = await gitlabFetch(
              host,
              `${base}/repository/files/${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(resolved.commit)}`,
              downloads,
              token,
            );
            if (!response.ok) {
              await response.body?.cancel();
              throw new Problem(502, "Could not download a pinned GitLab file");
            }
            const bytes = await boundedBytes(response, importMaxFileBytes());
            total += bytes.length;
            if (total > importMaxBytes())
              throw new Problem(413, importLimitMessage());
            if (
              /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(
                bytes.subarray(0, 100).toString("utf8"),
              )
            )
              throw new Problem(400, "Git LFS files are not supported");
            const gitHash = createHash("sha1")
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest("hex");
            if (gitHash !== entry.id)
              throw new Problem(
                502,
                "GitLab file does not match its pinned tree; Git LFS files are not supported",
              );
            const path = selected
              ? entry.path.slice(selected.length + 1)
              : entry.path;
            if (hasEmbeddedSecret(bytes.toString("utf8")))
              throw new Problem(
                400,
                `Possible embedded secret; import blocked: ${path}`,
              );
            files[index] = {
              path,
              content: bytes.toString("base64"),
              sha256: createHash("sha256").update(bytes).digest("hex"),
              size: bytes.length,
              executable: entry.mode === "100755",
            };
          } catch (error) {
            failure ??= error;
            cancel.abort();
            throw error;
          }
        }
      }),
    );
  } catch (error) {
    throw failure ?? error;
  }
  validateFiles(files);
  const instructions = Buffer.from(
    files.find((f) => f.path === "SKILL.md")!.content,
    "base64",
  ).toString("utf8");
  let frontmatter;
  try {
    frontmatter = matter(instructions).data;
  } catch {
    throw new Problem(400, "Invalid SKILL.md YAML frontmatter");
  }
  const id = frontmatter?.name;
  if (typeof id !== "string")
    throw new Problem(400, "SKILL.md must declare a name");
  const audit = inspectSkillPackage(
    "00000000-0000-0000-0000-000000000000",
    id,
    files,
  );
  if (!audit.compatible)
    throw new Problem(
      400,
      "Invalid skill: " +
        audit.issues
          .filter((i) => i.severity === "error")
          .map((i) => i.message)
          .join(" "),
    );
  const meta = metadata(id, files);
  if (
    meta.kind !== "skill" ||
    meta.archived ||
    meta.disabled ||
    meta.replacement ||
    meta.members.length
  )
    throw new Problem(
      400,
      "Imported skills cannot declare bundles, lifecycle controls or replacement targets",
    );
  const source: GitLabSource = {
    type: "gitlab",
    host,
    repository: target.project,
    commit: resolved.commit,
    ref: resolved.ref,
    path: selected,
    url: sourceUrl(host, target.project, resolved.commit, selected),
  };
  return {
    kind: "skill" as const,
    id,
    source,
    files,
    instructions,
    skipped,
    warnings: audit.issues,
  };
}
export async function openGitLabBatch(url: string, signal: AbortSignal) {
  const host = gitlabHost();
  if (!host) throw new Problem(404, "GitLab import is not configured");
  const target = parseGitLabUrl(url);
  const token = await gitlabImportToken();
  const release = claimImport();
  try {
    const resolved = await resolveTarget(host, target, signal, token);
    return {
      release,
      repository: target.project,
      commit: resolved.commit,
      ref: resolved.ref,
      candidates: listCandidates(resolved),
      ctx: { host, target, resolved, token },
    };
  } catch (error) {
    release();
    throw error;
  }
}
