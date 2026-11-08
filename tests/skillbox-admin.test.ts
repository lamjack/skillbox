import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app } from "../src/server/app";
import { db, migrate } from "../src/server/db";
import { publish } from "../src/server/library";
import { clients, profiles, revisions, skills } from "../src/server/schema";
import { eq, like } from "drizzle-orm";

let server: ReturnType<typeof Bun.serve>;
let configPath = "";
let seedId = "";
const principal = {
  id: "admin-cli-test",
  name: "Admin CLI test",
  role: "admin" as const,
  allSkills: true,
  skillIds: [] as string[],
};

beforeAll(async () => {
  await migrate();
  seedId = "admin-cli-seed-" + randomUUID().slice(0, 8);
  const bytes = Buffer.from(
    `---\nname: ${seedId}\ndescription: Seed\n---\nBody.\n`,
  );
  await publish(
    principal,
    seedId,
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
  server = Bun.serve({ port: 0, fetch: app.fetch });
  const dir = mkdtempSync(join(tmpdir(), "skillbox-admin-"));
  configPath = join(dir, "admin.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      url: `http://127.0.0.1:${server.port}`,
      token: process.env.SKILLBOX_ADMIN_TOKEN,
    }),
    { mode: 0o600 },
  );
});
afterAll(async () => {
  server?.stop();
  // Clean up everything this file created (foreign-key order).
  await db.delete(clients).where(like(clients.name, "admin-cli-%"));
  await db.delete(profiles).where(like(profiles.name, "admin-cli-%"));
  await db.delete(revisions).where(like(revisions.skillId, "admin-cli-%"));
  await db.delete(skills).where(like(skills.id, "admin-cli-%"));
});

async function rpc(messages: object[], config = configPath) {
  const input =
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const proc = Bun.spawn(["node", "cli/skillbox-admin.mjs", "mcp"], {
    env: { ...process.env, SKILLBOX_ADMIN_CONFIG: config },
    cwd: new URL("..", import.meta.url).pathname,
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const byId: Record<number, any> = {};
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (typeof r.id === "number") byId[r.id] = r;
  }
  if (err) process.stderr.write("skillbox-admin stderr: " + err);
  return byId;
}

test(
  "admin stdio server lists tools and manages library, profiles and clients",
  async () => {
    const msgs = await rpc([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_skills", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_profiles", arguments: {} } },
    ]);
    expect(msgs[1].result.serverInfo.name).toBe("skillbox-admin");
    expect(msgs[1].result.instructions).toContain("confirm intent");
    const names = msgs[2].result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      [
        "check_updates",
        "create_client",
        "create_profile",
        "delete_profile",
        "get_proposal",
        "get_skill",
        "import_preview",
        "import_publish_batch",
        "list_clients",
        "list_events",
        "list_profiles",
        "list_proposals",
        "list_skills",
        "review_proposal",
        "set_skill_status",
        "settings_status",
        "update_client",
        "update_profile",
        "upsert_bundle",
        "usage_summary",
      ].sort(),
    );
    const skillsList = JSON.parse(msgs[3].result.content[0].text);
    expect(skillsList.items.some((s: any) => s.id === seedId)).toBe(true);
    expect(Array.isArray(JSON.parse(msgs[4].result.content[0].text))).toBe(
      true,
    );

    // upsert_bundle with the seeded skill, then read it back.
    const msgs2 = await rpc([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upsert_bundle", arguments: { id: "admin-cli-bundle-" + randomUUID().slice(0, 6), name: "CLI bundle", description: "Created over stdio", members: [seedId] } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_profile", arguments: { name: "admin-cli-profile-" + randomUUID().slice(0, 6), grants: [], allSkills: true, permissions: { create: false, update: false, archive: false, proposal: false } } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_profiles", arguments: {} } },
    ]);
    const bundle = JSON.parse(msgs2[1].result.content[0].text);
    expect(bundle.id).toContain("admin-cli-bundle-");
    const msgs3 = await rpc([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_skill", arguments: { id: bundle.id } } },
    ]);
    const fetched = JSON.parse(msgs3[1].result.content[0].text);
    expect(fetched.composition?.members).toContain(seedId);
    const profiles = JSON.parse(msgs2[3].result.content[0].text);
    const profileId = profiles.find((p: any) =>
      p.name.startsWith("admin-cli-profile-"),
    ).id;
    // create_client returns the one-time key with the warning line.
    const msgs4 = await rpc([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_client", arguments: { name: "admin-cli-client-" + randomUUID().slice(0, 6), profileId } } },
    ]);
    const clientText = msgs4[1].result.content[0].text;
    expect(clientText).toContain("Key shown once; store it now.");
    const client = JSON.parse(clientText.slice(clientText.indexOf("\n") + 1));
    expect(client.key ?? client.token ?? client.secret).toBeTruthy();

    // Optional tool fields must still satisfy the REST schemas: a bundle
    // created without name/description, and a partial permissions update.
    const msgs5 = await rpc([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upsert_bundle", arguments: { id: "admin-cli-bare-" + randomUUID().slice(0, 6), members: [seedId] } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_profile", arguments: { id: profileId, permissions: { proposal: true } } } },
    ]);
    const bare = JSON.parse(msgs5[1].result.content[0].text);
    expect(bare.id).toContain("admin-cli-bare-");
    const bareDetail = JSON.parse(
      (await rpc([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_skill", arguments: { id: bare.id } } }]))[1].result.content[0].text,
    );
    expect(bareDetail.metadata.description).toContain(seedId);
    expect(msgs5[2].result.isError).toBeFalsy();
    const updated = JSON.parse(msgs5[2].result.content[0].text);
    expect(updated.permissions).toMatchObject({ propose: true, create: false });
  },
  90_000,
);

test(
  "analytics and status tools stay read-only and never leak secrets",
  async () => {
    const secret = "fixture-gateway-secret-abc123";
    const { configureGateway } = await import("../src/server/gateway");
    try {
      await configureGateway({ apiKey: secret } as any);
      const msgs = await rpc([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "usage_summary", arguments: { days: 30 } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "settings_status", arguments: {} } },
      ]);
      const usageText = msgs[1].result.content[0].text;
      // The human block precedes the JSON passthrough.
      expect(usageText.startsWith("Window: last 30 days")).toBe(true);
      expect(usageText).toContain("Totals:");
      expect(usageText).toContain("Never-read ids:");
      const status = JSON.parse(msgs[2].result.content[0].text);
      expect(Object.keys(status)).toEqual(["providers", "gitlab", "executor"]);
      expect(status.providers.vercel.configured).toBe(true);
      for (const text of [usageText, msgs[2].result.content[0].text]) {
        expect(text).not.toContain(secret);
        expect(text.toLowerCase()).not.toContain("apikey");
        expect(text).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
      }
    } finally {
      await configureGateway({ apiKey: null });
    }
  },
  90_000,
);

test("refuses a config file that is not mode 0600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skillbox-admin-bad-"));
  const bad = join(dir, "admin.json");
  writeFileSync(bad, JSON.stringify({ url: "http://127.0.0.1:1", token: "x".repeat(40) }), { mode: 0o644 });
  const proc = Bun.spawn(["node", "cli/skillbox-admin.mjs", "mcp"], {
    env: { ...process.env, SKILLBOX_ADMIN_CONFIG: bad },
    cwd: new URL("..", import.meta.url).pathname,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const err = await new Response(proc.stderr).text();
  expect(code).not.toBe(0);
  expect(err).toContain("0600");
  expect(err).not.toContain("x".repeat(40));
});
