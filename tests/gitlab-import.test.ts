import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../src/server/app";
import { connection, db, migrate } from "../src/server/db";
import { resetImportLimit } from "../src/server/import-limit";
import { revisions } from "../src/server/schema";
import {
  parseGitLabUrl,
  parseGitLabUrlOnHost,
  prepareGitLabImport,
} from "../src/server/gitlab-import";
import {
  configureGitLabImport,
  gitlabImportSettings,
} from "../src/server/gitlab-settings";
import {
  GITLAB_HOST,
  GITLAB_TOKEN,
  IMPORT_COMMIT,
  gitlabFixture,
} from "./fixtures/gitlab-import";

const headers = () => ({
  Authorization: "Bearer " + process.env.SKILLBOX_ADMIN_TOKEN,
  "Content-Type": "application/json",
});
const treeUrl = `https://${GITLAB_HOST}/fixture/skills/-/tree/${IMPORT_COMMIT}/skills/example`;
let previousHost: string | undefined;
function setHost(host: string | undefined) {
  if (host === undefined) delete process.env.SKILLBOX_GITLAB_HOST;
  else process.env.SKILLBOX_GITLAB_HOST = host;
}

async function withFetch<T>(
  fixture: ReturnType<typeof gitlabFixture>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fixture.fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

beforeAll(async () => {
  resetImportLimit();
  await migrate();
  previousHost = process.env.SKILLBOX_GITLAB_HOST;
  setHost(GITLAB_HOST);
  await configureGitLabImport({ token: GITLAB_TOKEN });
});
afterAll(async () => {
  resetImportLimit();
  setHost(previousHost);
  await configureGitLabImport({ token: "" });
});

test("GitLab URLs must use https on the configured host", () => {
  for (const url of [
    `http://${GITLAB_HOST}/fixture/skills`,
    `https://evil.example.com/fixture/skills`,
    `https://${GITLAB_HOST}.evil.test/fixture/skills`,
    `https://user@${GITLAB_HOST}/fixture/skills`,
    `https://${GITLAB_HOST}/fixture/skills?token=secret`,
    `https://${GITLAB_HOST}/fixture/skills/-/tree/main/%2e%2e`,
    `https://${GITLAB_HOST}/fixture/skills/-/blob/main/README.md`,
  ])
    expect(() => parseGitLabUrl(url)).toThrow();
  expect(
    parseGitLabUrl(`https://${GITLAB_HOST}/fixture/skills/-/tree/main/x`),
  ).toMatchObject({ kind: "tree" });
});

test("nested subgroup URLs resolve to the full project path", () => {
  expect(
    parseGitLabUrlOnHost(
      `https://${GITLAB_HOST}/group/sub/project/-/tree/main/skills/example`,
      GITLAB_HOST,
    ),
  ).toMatchObject({
    project: "group/sub/project",
    kind: "tree",
    segments: ["main", "skills", "example"],
  });
  expect(
    parseGitLabUrlOnHost(`https://${GITLAB_HOST}/group/sub/project`, GITLAB_HOST),
  ).toMatchObject({ project: "group/sub/project", kind: "repo" });
});

test("GitLab preview follows tree pagination and pins the commit", async () => {
  const fixture = gitlabFixture("example", { secondPage: true });
  const result = await withFetch(fixture, () =>
    prepareGitLabImport({
      url: `https://${GITLAB_HOST}/fixture/skills/-/tree/main/skills/example`,
    }),
  );
  expect(result.kind).toBe("skill");
  if (result.kind !== "skill") throw Error("Expected package");
  expect(result.source.type).toBe("gitlab");
  expect(result.source.host).toBe(GITLAB_HOST);
  expect(result.source.repository).toBe("fixture/skills");
  expect(result.source.commit).toBe(IMPORT_COMMIT);
  expect(result.source.path).toBe("skills/example");
  expect(result.files).toHaveLength(3);
  expect(result.skipped).toEqual([".env"]);
  expect(
    fixture.requests.filter((url) => url.includes("repository/tree")).length,
  ).toBe(2);
  expect(
    fixture.requests
      .filter((url) => url.includes("/repository/files/"))
      .every((url) => url.includes(`ref=${IMPORT_COMMIT}`)),
  ).toBe(true);
});

test("GitLab import fails closed on tampered files, symlinks and submodules", async () => {
  for (const [options, message] of [
    [{ corrupt: true }, "does not match its pinned tree"],
    [{ secret: true }, "Possible embedded secret"],
    [{ mode: "120000" }, "Symlinks and submodules"],
    [{ mode: "160000", type: "commit" }, "Symlinks and submodules"],
    [{ oversized: true }, "exceeds import limits"],
  ] as const) {
    const fixture = gitlabFixture("example", options);
    await withFetch(fixture, () =>
      expect(prepareGitLabImport({ url: treeUrl })).rejects.toThrow(message),
    );
  }
});

test("GitLab settings never expose the token and imports disable without a host", async () => {
  try {
    // Token-only PUT; GET never returns it.
    await configureGitLabImport({ token: "glpat-other" });
    const res = await app.request("/api/settings/gitlab-import", {
      headers: headers(),
    });
    const body = await res.json();
    expect(body).toMatchObject({ host: GITLAB_HOST, configured: true });
    expect(body).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain("glpat-");
    expect(body.updatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // Without SKILLBOX_GITLAB_HOST the import is disabled and GET reports null host.
    setHost(undefined);
    expect(await gitlabImportSettings()).toMatchObject({
      host: null,
      configured: true,
    });
    const fixture = gitlabFixture();
    await withFetch(fixture, () =>
      expect(prepareGitLabImport({ url: treeUrl })).rejects.toThrow(
        "GitLab import is not configured",
      ),
    );
    expect(() => parseGitLabUrl(treeUrl)).toThrow(
      "GitLab import is not configured",
    );
    // A URL on a different host than the configured one is rejected.
    setHost("other.example.com");
    expect(() => parseGitLabUrl(treeUrl)).toThrow();
  } finally {
    setHost(GITLAB_HOST);
    await configureGitLabImport({ token: GITLAB_TOKEN });
  }
});

test("GitLab publish records gitlab provenance on the revision", async () => {
  const fixture = gitlabFixture("gitlab-skill");
  await withFetch(fixture, async () => {
    const preview = await app.request("/api/imports/gitlab/preview", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ url: treeUrl }),
    });
    expect(preview.status).toBe(200);
    const res = await app.request("/api/imports/gitlab/publish", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        url: treeUrl,
        id: "gitlab-skill",
        expectedRevision: null,
      }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const [revision] = await db
      .select({ source: revisions.source })
      .from(revisions)
      .where(eq(revisions.skillId, id));
    expect(revision.source).toMatchObject({
      type: "gitlab",
      host: GITLAB_HOST,
      repository: "fixture/skills",
      commit: IMPORT_COMMIT,
      path: "skills/example",
    });
  });
  await connection`DELETE FROM revisions WHERE skill_id='gitlab-skill'`;
  await connection`DELETE FROM skills WHERE id='gitlab-skill'`;
});
