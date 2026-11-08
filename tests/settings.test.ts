import { expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connection, migrate } from "../src/server/db";
import { open, seal } from "../src/server/secret-storage";
import {
  allowedOrigins,
  appOrigin,
  executorResourceAliases,
} from "../src/server/config";

test("neutral defaults and explicit origin aliases", () => {
  const keys = [
    "SKILLBOX_ORIGIN",
    "SKILLBOX_ALLOWED_ORIGINS",
    "SKILLBOX_EXECUTOR_RESOURCE_ALIASES",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  try {
    expect(appOrigin()).toBe("http://127.0.0.1:4791");
    expect([...allowedOrigins()]).toEqual(["http://127.0.0.1:4791"]);
    expect(executorResourceAliases()).toEqual({});
    process.env.SKILLBOX_ORIGIN = "https://skills.example.com";
    process.env.SKILLBOX_ALLOWED_ORIGINS = "https://legacy.example.com";
    expect([...allowedOrigins()]).toEqual([
      "https://skills.example.com",
      "https://legacy.example.com",
    ]);
    process.env.SKILLBOX_ALLOWED_ORIGINS = "https://user:password@example.com";
    expect(allowedOrigins).toThrow();
    process.env.SKILLBOX_EXECUTOR_RESOURCE_ALIASES =
      '{"https://mcp.example.com":"http://wrong.example.com"}';
    expect(executorResourceAliases).toThrow();
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});

test("stored secrets use authenticated encryption, migrate legacy ciphertexts and fail closed after token changes", async () => {
  await migrate();
  const previous = process.env.SKILLBOX_ADMIN_TOKEN;
  process.env.SKILLBOX_ADMIN_TOKEN =
    "isolated-test-owner-token-at-least-32-chars";
  try {
    const encrypted = await seal({ apiKey: "fixture-secret" });
    expect(JSON.stringify(encrypted)).not.toContain("fixture-secret");
    expect(encrypted.data.startsWith("v2:")).toBe(true);
    expect(await open(encrypted)).toEqual({ apiKey: "fixture-secret" });
    expect(await seal({ apiKey: "fixture-secret" })).not.toEqual(encrypted);
    await expect(
      open({ ...encrypted, tag: Buffer.alloc(16).toString("base64") }),
    ).rejects.toThrow();

    // A legacy ciphertext (SHA-256 key, no v2 prefix) still opens, and when a
    // settings row is named it is re-sealed under the v2 key in place.
    const legacyKey = createHash("sha256")
      .update(process.env.SKILLBOX_ADMIN_TOKEN)
      .digest();
    const legacyIv = randomBytes(12);
    const legacyCipher = createCipheriv("aes-256-gcm", legacyKey, legacyIv);
    const legacyBytes = Buffer.concat([
      legacyCipher.update(JSON.stringify({ apiKey: "legacy-secret" })),
      legacyCipher.final(),
    ]);
    const legacySealed = {
      iv: legacyIv.toString("base64"),
      tag: legacyCipher.getAuthTag().toString("base64"),
      data: legacyBytes.toString("base64"),
    };
    expect(await open(legacySealed)).toEqual({ apiKey: "legacy-secret" });
    await connection`INSERT INTO workspace_settings(id, value) VALUES ('crypto_test_legacy', ${JSON.stringify(legacySealed)}::jsonb) ON CONFLICT(id) DO UPDATE SET value=excluded.value`;
    expect(await open(legacySealed, "crypto_test_legacy")).toEqual({
      apiKey: "legacy-secret",
    });
    const [migrated] =
      await connection`SELECT value FROM workspace_settings WHERE id='crypto_test_legacy'`;
    expect(
      (migrated.value as { data: string }).data.startsWith("v2:"),
    ).toBe(true);
    expect(await open(migrated.value as typeof legacySealed)).toEqual({
      apiKey: "legacy-secret",
    });
    await connection`DELETE FROM workspace_settings WHERE id='crypto_test_legacy'`;

    process.env.SKILLBOX_ADMIN_TOKEN =
      "different-test-owner-token-at-least-32-chars";
    await expect(open(encrypted)).rejects.toThrow();
    await expect(open(legacySealed)).rejects.toThrow();
    delete process.env.SKILLBOX_ADMIN_TOKEN;
    await expect(seal({ apiKey: "fixture-secret" })).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.SKILLBOX_ADMIN_TOKEN;
    else process.env.SKILLBOX_ADMIN_TOKEN = previous;
  }
});

test("setup creates unique private credentials without printing or overwriting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillbox-setup-test-"));
  const script = resolve("scripts/setup-env.ts");
  try {
    const run = () =>
      Bun.spawn([process.execPath, script], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = run();
    const output = await new Response(first.stdout).text();
    expect(await first.exited).toBe(0);
    const env = await readFile(join(dir, ".env"), "utf8");
    const admin = env.match(/^SKILLBOX_ADMIN_TOKEN=(.+)$/m)![1];
    const password = env.match(/^POSTGRES_PASSWORD=(.+)$/m)![1];
    expect(admin).toMatch(/^[a-f0-9]{64}$/);
    expect(password).toMatch(/^[a-f0-9]{48}$/);
    expect(output).not.toContain(admin);
    expect(output).not.toContain(password);
    expect((await stat(join(dir, ".env"))).mode & 0o777).toBe(0o600);
    const second = run();
    expect(await second.exited).toBe(1);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
