import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../src/server/app";
import { db, migrate } from "../src/server/db";
import { resetImportLimit } from "../src/server/import-limit";
import { revisions, skills } from "../src/server/schema";

const COMMIT = "d".repeat(40);
const headers = () => ({
  Authorization: "Bearer " + process.env.SKILLBOX_ADMIN_TOKEN,
  "Content-Type": "application/json",
});
const blobSha = (bytes: Buffer) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
function fixture(
  repo: string,
  dirs: { dir: string; id?: string; extra?: Record<string, string> }[],
  options: { commit?: string; deny?: boolean } = {},
) {
  const commit = options.commit ?? COMMIT;
  const files = dirs.flatMap((d) =>
    [
      {
        path: `${d.dir}/SKILL.md`,
        bytes: Buffer.from(
          d.id === null
            ? "---\ndescription: no name\n---\n"
            : `---\nname: ${d.id}\ndescription: Fixture\n---\nBody.\n`,
        ),
      },
      { path: `${d.dir}/.env`, bytes: Buffer.from("EXAMPLE=private") },
      { path: `${d.dir}/scripts/run.sh`, bytes: Buffer.from("#!/bin/sh\n") },
      ...Object.entries(d.extra ?? {}).map(([p, c]) => ({
        path: `${d.dir}/${p}`,
        bytes: Buffer.from(c),
      })),
    ],
  );
  const dirEntries = new Set<string>();
  for (const f of files)
    for (let i = f.path.indexOf("/"); i > 0; i = f.path.indexOf("/", i + 1))
      dirEntries.add(f.path.slice(0, i));
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (init?.redirect !== "error") throw new Error("redirects rejected");
    if (url.hostname === "api.github.com") {
      if (options.deny)
        return Response.json({ message: "rate limited" }, { status: 403 });
      if (url.pathname === `/repos/${repo}`)
        return Response.json({ default_branch: "main" });
      if (url.pathname.includes("/commits/"))
        return Response.json({
          sha: commit,
          commit: { tree: { sha: "e".repeat(40) } },
        });
      if (url.pathname.includes("/git/trees/"))
        return Response.json({
          tree: [
            ...[...dirEntries].map((path) => ({
              path,
              mode: "040000",
              type: "tree",
              sha: "f".repeat(40),
            })),
            ...files.map((f) => ({
              path: f.path,
              mode: "100644",
              type: "blob",
              size: f.bytes.length,
              sha: blobSha(f.bytes),
            })),
          ],
        });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const path = url.pathname.split("/").slice(4).map(decodeURIComponent).join("/");
      const file = files.find((f) => f.path === path);
      if (file) return new Response(file.bytes);
    }
    return new Response("Unexpected URL", { status: 404 });
  }) as typeof fetch;
  return { fetcher, requests };
}
let previousFetch: typeof fetch;
beforeAll(async () => {
  resetImportLimit();
  await migrate();
  previousFetch = globalThis.fetch;
});
afterAll(async () => {
  resetImportLimit();
  globalThis.fetch = previousFetch;
  for (const id of ["alpha", "beta", "gamma", "delta"]) {
    await db.delete(revisions).where(eq(revisions.skillId, id));
    await db.delete(skills).where(eq(skills.id, id));
  }
});

test("batch import creates, skips, updates and reports per-item errors", async () => {
  const v1 = fixture("fixture/skills", [
    { dir: "skills/alpha", id: "alpha" },
    { dir: "skills/beta", id: "beta" },
    { dir: "skills/gamma", id: "gamma" },
    { dir: "skills/bad", id: null as unknown as string },
  ]);
  globalThis.fetch = v1.fetcher;
  const url = "https://github.com/fixture/skills";
  // First import creates alpha only.
  let res = await app.request("/api/imports/github/publish-batch", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      url,
      items: [{ path: "skills/alpha", id: "alpha" }],
      overwrite: false,
    }),
  });
  expect(res.status).toBe(200);
  // Batch: alpha exists (skip), beta+gamma create, bad errors.
  v1.requests.length = 0;
  res = await app.request("/api/imports/github/publish-batch", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      url,
      items: [
        { path: "skills/alpha", id: "alpha" },
        { path: "skills/beta", id: "beta" },
        { path: "skills/gamma", id: "gamma" },
        { path: "skills/bad", id: "bad" },
      ],
      overwrite: false,
    }),
  });
  const body = await res.json();
  expect(body.source.repository).toBe("fixture/skills");
  expect(body.results.map((r: any) => [r.id, r.status])).toEqual([
    ["alpha", "skipped"],
    ["beta", "created"],
    ["gamma", "created"],
    ["bad", "error"],
  ]);
  // One resolve + one tree fetch for the whole batch.
  expect(
    v1.requests.filter((u) => u.includes("/git/trees/")).length,
  ).toBe(1);
  // overwrite updates alpha with a new revision.
  const [before] = await db
    .select({ revision: skills.revision })
    .from(skills)
    .where(eq(skills.id, "alpha"));
  res = await app.request("/api/imports/github/publish-batch", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      url,
      items: [{ path: "skills/alpha", id: "alpha" }],
      overwrite: true,
    }),
  });
  const updated = await res.json();
  expect(updated.results[0].status).toBe("updated");
  expect(updated.results[0].revision).not.toBe(before.revision);
  // ref recorded on the revision source.
  const [rev] = await db
    .select({ source: revisions.source })
    .from(revisions)
    .where(eq(revisions.skillId, "alpha"));
  expect((rev.source as any).ref).toBe("main");
});

test("check-updates reports current, outdated, missing and group errors", async () => {
  // Seed delta from a second repo, then break that repo's API.
  const other = fixture("fixture/other", [{ dir: "skills/delta", id: "delta" }]);
  globalThis.fetch = other.fetcher;
  await app.request("/api/imports/github/publish-batch", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      url: "https://github.com/fixture/other",
      items: [{ path: "skills/delta", id: "delta" }],
      overwrite: false,
    }),
  });
  // v2: alpha changed (outdated), beta dir gone (missing), gamma unchanged (current), delta's repo 403 (error).
  const v2 = fixture("fixture/skills", [
    { dir: "skills/alpha", id: "alpha", extra: { "new.txt": "changed" } },
    { dir: "skills/gamma", id: "gamma" },
  ]);
  const deny = fixture("fixture/other", [], { deny: true });
  globalThis.fetch = ((input: any, init?: any) => {
    const url = new URL(String(input));
    return url.href.includes("fixture/other")
      ? deny.fetcher(input, init)
      : v2.fetcher(input, init);
  }) as typeof fetch;
  const res = await app.request("/api/imports/check-updates", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const byId = Object.fromEntries(
    body.results.map((r: any) => [r.id, r]),
  );
  expect(byId.gamma.status).toBe("current");
  expect(byId.alpha.status).toBe("outdated");
  expect(byId.alpha.message).toContain("extra: new.txt");
  expect(byId.beta.status).toBe("missing");
  expect(byId.delta.status).toBe("error");
  expect(byId.alpha.headCommit).toBe(COMMIT);
  expect(byId.alpha.storedCommit).toBe(COMMIT);
  expect(byId.delta.headCommit).toBeNull();
  expect(typeof body.checkedAt).toBe("string");
});
