import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../src/server/app";
import { db, migrate } from "../src/server/db";
import { revisions, skills } from "../src/server/schema";
import { eq } from "drizzle-orm";
import { publish } from "../src/server/library";
import { createHash, randomUUID } from "node:crypto";

let server: ReturnType<typeof Bun.serve>;
let home: string;
let seedId = "";
async function run(payload: object) {
  // Async spawn keeps this process's event loop free so the in-test
  // Bun.serve can answer the installer's downloads and MCP smoke test.
  const proc = Bun.spawn(["python3", "scripts/install-client.py"], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...process.env, HOME: home },
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
const payload = (port: number) => ({
  clients: {
    devin: {
      url: `http://127.0.0.1:${port}`,
      token: process.env.SKILLBOX_ADMIN_TOKEN,
      allowInsecureHttp: true,
    },
  },
});
const principal = {
  id: "installer-test",
  name: "Installer test",
  role: "admin" as const,
  allSkills: true,
  skillIds: [] as string[],
};
beforeAll(async () => {
  await migrate();
  const seed = "installer-seed-" + randomUUID().slice(0, 8);
  seedId = seed;
  const bytes = Buffer.from(
    `---\nname: ${seed}\ndescription: Seed\n---\nBody.\n`,
  );
  await publish(
    principal,
    seed,
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
    "Seed for installer test",
  );
  server = Bun.serve({ port: 0, fetch: app.fetch });
  home = mkdtempSync(join(tmpdir(), "skillbox-install-"));
});
afterAll(async () => {
  server?.stop();
  // Do not leak the seed into other test files sharing this database.
  if (seedId) {
    await db.delete(revisions).where(eq(revisions.skillId, seedId));
    await db.delete(skills).where(eq(skills.id, seedId));
  }
});

test("installer registers devin config, mcp entry and CLI shim", async () => {
  const port = server.port!;
  const run1 = await run(payload(port));
  expect(run1.exitCode).toBe(0);
  const devinJson = join(home, ".config/skillbox/devin.json");
  expect(statSync(devinJson).mode & 0o777).toBe(0o600);
  const mcp = JSON.parse(
    readFileSync(join(home, ".config/devin/mcp_config.json"), "utf8"),
  );
  const entry = mcp.mcpServers?.skillbox;
  expect(entry).toBeDefined();
  expect(entry.args.at(-1)).toBe("mcp");
  expect(entry.env.SKILLBOX_CONFIG).toBe(devinJson);
  const shim = join(home, ".local/bin/skillbox");
  expect(existsSync(shim)).toBe(true);
  expect(statSync(shim).mode & 0o111).not.toBe(0);
  expect(readFileSync(shim, "utf8")).toContain("SKILLBOX_CONFIG");
  // Second run with a differing existing entry refuses.
  writeFileSync(
    join(home, ".config/devin/mcp_config.json"),
    JSON.stringify({
      mcpServers: { skillbox: { command: "other", args: ["x"] } },
    }),
  );
  const run2 = await run(payload(port));
  expect(run2.exitCode).not.toBe(0);
}, 120_000);