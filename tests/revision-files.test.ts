import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { migrate, db, connection } from "../src/server/db";
import {
  blobs,
  events,
  revisionFiles,
  revisions,
  skills,
} from "../src/server/schema";
import { eq, inArray, like } from "drizzle-orm";
import {
  ADMIN,
  load,
  makeFile,
  metadata,
  publish,
  readFile,
  revisionFor,
} from "../src/server/library";
import type { SkillFile } from "../src/shared";
import { loadProposalFiles } from "../src/server/revision-files";

const PREFIX = "test-rf-";
const byPath = (files: SkillFile[]) =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.delete(revisions).where(like(revisions.skillId, PREFIX + "%"));
  await db.delete(skills).where(like(skills.id, PREFIX + "%"));
  await db.delete(events).where(like(events.skillId, PREFIX + "%"));
  await connection`DELETE FROM blobs WHERE NOT EXISTS(SELECT 1 FROM revision_files f WHERE f.sha256=blobs.sha256)`;
});

test("legacy revisions.files jsonb migrates into content-addressed storage", async () => {
  const id = PREFIX + "legacy-" + randomUUID().slice(0, 8);
  const revision = randomUUID();
  const files = [
    makeFile("assets/blob.bin", Buffer.from([0, 1, 2, 3, 255])),
    makeFile(
      "SKILL.md",
      `---\nname: ${id}\ndescription: Legacy fixture\n---\nBody`,
    ),
  ];
  await connection`ALTER TABLE revisions ADD COLUMN IF NOT EXISTS files jsonb`;
  await connection`INSERT INTO skills (id,title,description,revision,search_text) VALUES (${id},'Legacy','Legacy fixture',${revision},'legacy')`;
  await connection`INSERT INTO revisions (id,skill_id,metadata,files,checksum,message,author) VALUES (${revision},${id},${JSON.stringify(metadata(id, files))}::jsonb,${JSON.stringify(files)}::jsonb,'legacy','Legacy import','tester')`;
  await migrate();
  const columns =
    await connection`SELECT column_name FROM information_schema.columns WHERE table_name='revisions'`;
  expect(columns.some((c) => c.column_name === "files")).toBe(false);
  expect(
    await db
      .select()
      .from(revisionFiles)
      .where(eq(revisionFiles.revisionId, revision)),
  ).toHaveLength(2);
  expect(
    await db
      .select()
      .from(blobs)
      .where(
        inArray(
          blobs.sha256,
          files.map((f) => f.sha256),
        ),
      ),
  ).toHaveLength(2);
  expect((await revisionFor(ADMIN, id)).files).toEqual(byPath(files));
});

test("identical file bytes share one blob across revisions", async () => {
  const id = PREFIX + "dedupe-" + randomUUID().slice(0, 8);
  const guide = makeFile("references/guide.md", "Reference content");
  const first = [
    makeFile(
      "SKILL.md",
      `---\nname: ${id}\ndescription: Fixture\n---\nVersion one`,
    ),
    guide,
  ];
  const r1 = await publish(ADMIN, id, first, null);
  const second = [
    makeFile(
      "SKILL.md",
      `---\nname: ${id}\ndescription: Fixture\n---\nVersion two`,
    ),
    guide,
  ];
  const r2 = await publish(ADMIN, id, second, r1.revision);
  expect(
    await db.select().from(blobs).where(eq(blobs.sha256, guide.sha256)),
  ).toHaveLength(1);
  expect((await revisionFor(ADMIN, id, r1.revision)).files).toEqual(
    byPath(first),
  );
  expect((await revisionFor(ADMIN, id, r2.revision)).files).toEqual(
    byPath(second),
  );
});

test("readFile applies the inline limit first and load lists files without content", async () => {
  const id = PREFIX + "read-" + randomUUID().slice(0, 8);
  await publish(
    ADMIN,
    id,
    [
      makeFile(
        "SKILL.md",
        `---\nname: ${id}\ndescription: Fixture\n---\nSmall body`,
      ),
      makeFile("references/big.txt", "x".repeat(170_000)),
    ],
    null,
  );
  const small = await readFile(ADMIN, id, undefined, "SKILL.md");
  expect(small.text).toContain("Small body");
  await expect(
    readFile(ADMIN, id, undefined, "references/big.txt"),
  ).rejects.toMatchObject({ status: 413 });
  const loaded = await load(ADMIN, id);
  expect(loaded.files).toHaveLength(2);
  expect(loaded.files.every((f) => (f as any).content === undefined)).toBe(
    true,
  );
  expect(loaded.instructions).toContain("Small body");
});

test("deleting a revision cascades its revision_files rows", async () => {
  const id = PREFIX + "cascade-" + randomUUID().slice(0, 8);
  const r = await publish(
    ADMIN,
    id,
    [makeFile("SKILL.md", `---\nname: ${id}\ndescription: Fixture\n---\nBody`)],
    null,
  );
  expect(
    await db
      .select()
      .from(revisionFiles)
      .where(eq(revisionFiles.revisionId, r.revision)),
  ).toHaveLength(1);
  await db.delete(revisions).where(eq(revisions.id, r.revision));
  expect(
    await db
      .select()
      .from(revisionFiles)
      .where(eq(revisionFiles.revisionId, r.revision)),
  ).toHaveLength(0);
});

test("identical content at two paths stores one blob", async () => {
  const id = PREFIX + "dup-" + randomUUID().slice(0, 8);
  const files = [
    makeFile("SKILL.md", `---\nname: ${id}\ndescription: Fixture\n---\nBody`),
    makeFile("references/a.txt", "shared bytes"),
    makeFile("references/b.txt", "shared bytes"),
  ];
  const r = await publish(ADMIN, id, files, null);
  const sha = files[1].sha256;
  expect(files[2].sha256).toBe(sha);
  expect(
    await db.select().from(blobs).where(eq(blobs.sha256, sha)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(revisionFiles)
      .where(eq(revisionFiles.revisionId, r.revision)),
  ).toHaveLength(3);
  expect((await revisionFor(ADMIN, id)).files).toEqual(byPath(files));
});

test("readResource rejects files over the inline limit before loading bytes", async () => {
  const id = PREFIX + "limit-" + randomUUID().slice(0, 8);
  const previous = process.env.SKILLBOX_MCP_RESOURCE_MAX_BYTES;
  process.env.SKILLBOX_MCP_RESOURCE_MAX_BYTES = "1000";
  try {
    await publish(
      ADMIN,
      id,
      [
        makeFile(
          "SKILL.md",
          `---\nname: ${id}\ndescription: Fixture\n---\nSmall`,
        ),
        makeFile("references/big.txt", "z".repeat(2000)),
      ],
      null,
    );
    const { referenceId } = await load(ADMIN, id);
    const { skillResourceUri } = await import("../src/skill-manifest");
    const { readResource } = await import("../src/server/skill-resources");
    await expect(
      readResource(
        ADMIN,
        skillResourceUri(referenceId, id, "references/big.txt"),
      ),
    ).rejects.toMatchObject({ status: 413 });
    const small = await readResource(
      ADMIN,
      skillResourceUri(referenceId, id, "SKILL.md"),
    );
    expect(small.contents[0].text).toContain("Small");
  } finally {
    if (previous === undefined)
      delete process.env.SKILLBOX_MCP_RESOURCE_MAX_BYTES;
    else process.env.SKILLBOX_MCP_RESOURCE_MAX_BYTES = previous;
  }
});

test("legacy proposals.files jsonb migrates into proposal_files", async () => {
  const id = PREFIX + randomUUID().slice(0, 8);
  const files = byPath([
    makeFile(
      "SKILL.md",
      `---\nname: ${id}\ndescription: Proposal fixture\n---\n\nBody`,
    ),
    makeFile("assets/blob.bin", Buffer.from([0, 1, 2, 255])),
  ]);
  await connection`ALTER TABLE proposals ADD COLUMN IF NOT EXISTS files jsonb`;
  await connection`INSERT INTO proposals(id,skill_id,client_id,client_name,expected_revision,files,message) VALUES (${id},${id},'client','Client','rev',${JSON.stringify(files)}::jsonb,'legacy')`;
  try {
    await migrate();
    const [column] =
      await connection`SELECT 1 FROM information_schema.columns WHERE table_name='proposals' AND column_name='files'`;
    expect(column).toBeUndefined();
    expect(await loadProposalFiles(db, id)).toEqual(files);
    await connection`DELETE FROM proposals WHERE id=${id}`;
    const [{ count }] =
      await connection`SELECT count(*)::int AS count FROM proposal_files WHERE proposal_id=${id}`;
    expect(count).toBe(0);
  } finally {
    await connection`DELETE FROM proposals WHERE id=${id}`;
  }
});
