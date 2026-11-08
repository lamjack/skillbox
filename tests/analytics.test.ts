import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { app } from "../src/server/app";
import { db, migrate } from "../src/server/db";
import { publish } from "../src/server/library";
import { events, revisions, skills } from "../src/server/schema";
import { eq, like } from "drizzle-orm";

const principal = {
  id: "analytics-test",
  name: "Analytics test",
  role: "admin" as const,
  allSkills: true,
  skillIds: [] as string[],
};
const headers = {
  Authorization: "Bearer " + (process.env.SKILLBOX_ADMIN_TOKEN ?? ""),
  "Content-Type": "application/json",
};
let readSkill = "";
let quietSkill = "";

beforeAll(async () => {
  await migrate();
  readSkill = "analytics-read-" + randomUUID().slice(0, 8);
  quietSkill = "analytics-quiet-" + randomUUID().slice(0, 8);
  for (const id of [readSkill, quietSkill]) {
    const bytes = Buffer.from(
      `---\nname: ${id}\ndescription: Seed\n---\nBody.\n`,
    );
    await publish(
      principal,
      id,
      [
        {
          path: "SKILL.md",
          content: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          executable: false,
        },
      ],
      null,
      "Seed",
    );
  }
  const now = new Date();
  const old = new Date(Date.now() - 90 * 86400_000);
  const row = (
    operation: string,
    source: string | null,
    skillId: string,
    at: Date,
    client = "probe",
  ) => ({
    id: randomUUID(),
    clientId: "analytics-client",
    clientName: client,
    operation,
    skillId,
    context: { source: source ?? "legacy" },
    createdAt: at.toISOString(),
  });
  await db.insert(events).values([
    // Two counted reads for readSkill (mcp + cli).
    row("load", "mcp", readSkill, now),
    row("read_file", "cli", readSkill, now, "second-client"),
    // A web read must NOT count toward reads.
    row("load", "web", readSkill, now),
    // One reported use.
    row("reported_use", "mcp", readSkill, now),
    // An old counted read outside the 30-day window.
    row("load", "mcp", readSkill, old),
  ]);
});
afterAll(async () => {
  await db.delete(events).where(eq(events.clientId, "analytics-client"));
  await db.delete(revisions).where(like(revisions.skillId, "analytics-%"));
  await db.delete(skills).where(like(skills.id, "analytics-%"));
});

test("/api/analytics/usage aggregates reads, uses and never-read per window", async () => {
  const res = await app.request("/api/analytics/usage?days=30", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window.days).toBe(30);
  const byId = Object.fromEntries(
    body.skills.map((r: any) => [r.id, r]),
  );
  const read = byId[readSkill];
  const quiet = byId[quietSkill];
  expect(read).toBeDefined();
  expect(quiet).toBeDefined();
  // mcp + cli reads count; web and legacy events do not.
  expect(Number(read.reads)).toBe(2);
  expect(Number(read.reportedUses)).toBe(1);
  expect(Number(quiet.reads)).toBe(0);
  expect(read.status).toBe("enabled");
  expect(read.clients).toEqual(
    expect.arrayContaining(["probe", "second-client"]),
  );
  expect(body.totals.skills).toBeGreaterThanOrEqual(2);
  expect(body.totals.neverRead).toBeGreaterThanOrEqual(1);
  expect(body.totals.readsInWindow).toBeGreaterThanOrEqual(2);
  // Old events fall outside the window.
  const res1 = await app.request("/api/analytics/usage?days=120", {
    headers,
  });
  const wider = await res1.json();
  const widerRead = wider.skills.find((r: any) => r.id === readSkill);
  expect(Number(widerRead.reads)).toBe(3);
});
