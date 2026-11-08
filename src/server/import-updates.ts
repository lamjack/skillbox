import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { listGitShas } from "./revision-files";
import { revisions, skills } from "./schema";
import { claimImport } from "./import-limit";
import { githubJson, githubRepoUnder } from "./github-import";
import { gitlabFetch } from "./gitlab-import";
import { gitlabImportToken } from "./gitlab-settings";
import { gitlabHost } from "./config";
import { excludedImportPath } from "../skill-import-safety";
import { Problem } from "./library";
import type { GitHubSource, GitLabSource } from "../shared";

async function githubHead(
  repo: string,
  ref: string | undefined,
  signal: AbortSignal,
) {
  if (!ref) {
    const repository = await githubJson(`/repos/${repo}`, signal);
    if (typeof repository.default_branch !== "string")
      throw new Problem(502, "Repository has no default branch");
    ref = repository.default_branch;
  }
  const commit = await githubJson(
    `/repos/${repo}/commits/${encodeURIComponent(ref as string)}?per_page=1`,
    signal,
  );
  if (typeof commit?.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha))
    throw new Problem(502, "Invalid GitHub commit response");
  const tree = await githubJson(
    `/repos/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`,
    signal,
  );
  if (tree.truncated || !Array.isArray(tree.tree))
    throw new Problem(502, "Repository tree is too large to compare");
  return { commit: commit.sha as string, entries: tree.tree as any[] };
}
async function gitlabHead(
  host: string,
  project: string,
  ref: string | undefined,
  token: string | null,
  signal: AbortSignal,
) {
  const base = `/api/v4/projects/${encodeURIComponent(project)}`;
  if (!ref) {
    const info = await gitlabFetch(host, base, signal, token);
    if (!info.ok) throw new Problem(502, "GitLab project request failed");
    const project = JSON.parse(
      Buffer.from(await info.arrayBuffer()).toString("utf8"),
    ) as any;
    ref = project.default_branch;
    if (typeof ref !== "string" || !ref)
      throw new Problem(502, "Project has no default branch");
  }
  const commitResponse = await gitlabFetch(
    host,
    `${base}/repository/commits/${encodeURIComponent(ref)}`,
    signal,
    token,
  );
  if (!commitResponse.ok)
    throw new Problem(
      commitResponse.status === 404 ? 404 : 502,
      "GitLab commit request failed",
    );
  const commit = JSON.parse(
    Buffer.from(await commitResponse.arrayBuffer()).toString("utf8"),
  ) as any;
  if (typeof commit?.id !== "string" || !/^[0-9a-f]{40}$/.test(commit.id))
    throw new Problem(502, "Invalid GitLab commit response");
  const entries: any[] = [];
  for (let page = 1; ; page++) {
    const response = await gitlabFetch(
      host,
      `${base}/repository/tree?ref=${encodeURIComponent(commit.id)}&recursive=true&per_page=100&page=${page}`,
      signal,
      token,
    );
    if (!response.ok) throw new Problem(502, "GitLab tree request failed");
    const chunk = JSON.parse(
      Buffer.from(await response.arrayBuffer()).toString("utf8"),
    );
    if (!Array.isArray(chunk)) throw new Problem(502, "Invalid GitLab tree");
    entries.push(...chunk);
    if (entries.length > 10_000)
      throw new Problem(413, "Repository tree is too large to compare");
    const next = response.headers.get("x-next-page");
    if (!next || Number(next) !== page + 1) break;
  }
  return { commit: commit.id as string, entries };
}
function compareSkill(
  files: { path: string; gitSha1: string | null }[],
  dir: string,
  entries: { path: string; id: string; type?: string }[],
): { status: "current" | "outdated" | "missing"; message?: string } {
  // GitHub/GitLab trees list directories too; only blobs are files, and the
  // importer's exclusion predicate must apply here as well.
  const treeFiles = new Map<string, string>();
  let dirSeen = !dir;
  for (const entry of entries) {
    if (!githubRepoUnder(entry.path, dir)) continue;
    dirSeen = true;
    if (entry.type === "tree") continue;
    const relative = dir ? entry.path.slice(dir.length + 1) : entry.path;
    if (!relative || excludedImportPath(relative)) continue;
    treeFiles.set(relative, entry.id);
  }
  if (!dirSeen) return { status: "missing" };
  const stored = new Map(files.map((f) => [f.path, f.gitSha1]));
  const changed: string[] = [],
    missing: string[] = [],
    extra: string[] = [];
  for (const [path, sha] of stored) {
    const head = treeFiles.get(path);
    if (head === undefined) missing.push(path);
    else if (head !== sha) changed.push(path);
  }
  for (const path of treeFiles.keys()) if (!stored.has(path)) extra.push(path);
  if (!changed.length && !missing.length && !extra.length)
    return { status: "current" };
  const list = (paths: string[]) =>
    paths.slice(0, 5).join(", ") + (paths.length > 5 ? "…" : "");
  const parts: string[] = [];
  if (changed.length) parts.push(`changed: ${list(changed)}`);
  if (missing.length) parts.push(`missing: ${list(missing)}`);
  if (extra.length) parts.push(`extra: ${list(extra)}`);
  return { status: "outdated", message: parts.join("; ") };
}
export async function checkImportUpdates() {
  const release = claimImport();
  const signal = AbortSignal.timeout(180_000);
  const results: {
    id: string;
    status: "current" | "outdated" | "missing" | "error";
    type: "github" | "gitlab";
    host?: string;
    repository: string;
    path: string;
    storedCommit: string;
    headCommit: string | null;
    message?: string;
  }[] = [];
  try {
    const rows = await db
      .select({
        id: skills.id,
        source: revisions.source,
        revisionId: revisions.id,
      })
      .from(skills)
      .innerJoin(
        revisions,
        and(
          eq(revisions.skillId, skills.id),
          eq(revisions.id, skills.revision),
        ),
      )
      .where(
        and(
          eq(skills.kind, "skill"),
          eq(skills.archived, false),
          eq(skills.disabled, false),
        ),
      );
    const groups = new Map<
      string,
      {
        type: "github" | "gitlab";
        host?: string;
        repository: string;
        ref?: string;
        rows: typeof rows;
      }
    >();
    for (const row of rows) {
      const source = row.source as GitHubSource | GitLabSource | null;
      if (!source || (source.type !== "github" && source.type !== "gitlab"))
        continue;
      const key = `${source.type}|${source.type === "gitlab" ? (source as GitLabSource).host : ""}|${source.repository}|${source.ref ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          type: source.type,
          repository: source.repository,
          ref: source.ref,
          rows: [],
        };
        if (source.type === "gitlab")
          group.host = (source as GitLabSource).host;
        groups.set(key, group);
      }
      group.rows.push(row);
    }
    for (const group of groups.values()) {
      let head: { commit: string; entries: { path: string; id: string }[] };
      try {
        signal.throwIfAborted();
        if (group.type === "github") {
          const resolved = await githubHead(
            group.repository,
            group.ref,
            signal,
          );
          head = {
            commit: resolved.commit,
            entries: resolved.entries.map((e: any) => ({
              path: e.path,
              id: e.sha,
              type: e.type,
            })),
          };
        } else {
          if (!group.host || group.host !== gitlabHost())
            throw new Problem(
              400,
              "Configured GitLab host does not match the imported source",
            );
          const resolved = await gitlabHead(
            group.host,
            group.repository,
            group.ref,
            await gitlabImportToken(),
            signal,
          );
          head = resolved;
        }
      } catch (error) {
        for (const row of group.rows) {
          const source = row.source as GitHubSource | GitLabSource;
          results.push({
            id: row.id,
            status: "error",
            type: group.type,
            ...(group.host ? { host: group.host } : {}),
            repository: group.repository,
            path: source.path,
            storedCommit: source.commit,
            headCommit: null,
            message: (error as Error).message,
          });
        }
        continue;
      }
      for (const row of group.rows) {
        const source = row.source as GitHubSource | GitLabSource;
        const compared = compareSkill(
          await listGitShas(db, row.revisionId),
          source.path,
          head.entries,
        );
        results.push({
          id: row.id,
          status: compared.status,
          ...(compared.message ? { message: compared.message } : {}),
          type: group.type,
          ...(group.host ? { host: group.host } : {}),
          repository: group.repository,
          path: source.path,
          storedCommit: source.commit,
          headCommit: head.commit,
        });
      }
    }
  } finally {
    release();
  }
  return { checkedAt: new Date().toISOString(), results };
}
