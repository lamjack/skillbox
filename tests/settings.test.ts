import { expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "../src/server/app";
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
    expect((migrated.value as { data: string }).data.startsWith("v2:")).toBe(
      true,
    );
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

test("secrets sealed under a previous admin token read as unconfigured and are overwritten by a new save", async () => {
  await migrate();
  const headers = {
    Authorization: "Bearer " + process.env.SKILLBOX_ADMIN_TOKEN,
    "Content-Type": "application/json",
  };
  const current = process.env.SKILLBOX_ADMIN_TOKEN;
  process.env.SKILLBOX_ADMIN_TOKEN =
    "rotated-fixture-admin-token-" + randomBytes(8).toString("hex");
  try {
    for (const [id, value] of [
      ["ai_gateway", { revision: "r", provider: "vercel", apiKey: "sk-old" }],
      [
        "gitlab_import",
        { token: "glpat-old", updatedAt: new Date().toISOString() },
      ],
      ["executor", { endpoint: "https://old.example" }],
    ] as const) {
      const sealed = JSON.stringify(await seal(value));
      await connection`INSERT INTO workspace_settings(id,value) VALUES (${id},${sealed}::jsonb) ON CONFLICT(id) DO UPDATE SET value=excluded.value`;
    }
  } finally {
    process.env.SKILLBOX_ADMIN_TOKEN = current;
  }
  try {
    for (const path of ["ai-gateway", "gitlab-import", "executor"]) {
      const response = await app.request(`/api/settings/${path}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.configured).toBe(false);
      expect(body.secretState).toBe("unreadable");
      expect(JSON.stringify(body)).not.toMatch(/sk-old|glpat-old|old\.example/);
    }
    const saved = await app.request("/api/settings/ai-gateway", {
      method: "PUT",
      headers,
      body: JSON.stringify({ provider: "vercel", apiKey: "sk-fixture-new" }),
    });
    expect(saved.status).toBe(200);
    const gateway = await (
      await app.request("/api/settings/ai-gateway", { headers })
    ).json();
    expect(gateway.configured).toBe(true);
    expect(gateway.secretState).toBe("readable");
  } finally {
    await connection`DELETE FROM workspace_settings WHERE id IN ('ai_gateway','gitlab_import','executor')`;
  }
});

test("settings GET responses never return stored secrets and expose updatedAt", async () => {
  await migrate();
  const headers = {
    Authorization: "Bearer " + process.env.SKILLBOX_ADMIN_TOKEN,
    "Content-Type": "application/json",
  };
  const secrets = {
    gateway: "sk-fixture-gateway-secret",
    gitlab: "glpat-fixture-gitlab-secret",
  };
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  try {
    expect(
      (
        await app.request("/api/settings/ai-gateway", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            provider: "vercel",
            apiKey: secrets.gateway,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/settings/gitlab-import", {
          method: "PUT",
          headers,
          body: JSON.stringify({ token: secrets.gitlab }),
        })
      ).status,
    ).toBe(200);
    const gateway = await (
      await app.request("/api/settings/ai-gateway", { headers })
    ).json();
    const gitlab = await (
      await app.request("/api/settings/gitlab-import", { headers })
    ).json();
    for (const body of [gateway, gitlab])
      for (const secret of Object.values(secrets))
        expect(JSON.stringify(body)).not.toContain(secret);
    expect(gateway.providers.vercel.updatedAt).toMatch(iso);
    expect(gitlab.updatedAt).toMatch(iso);
  } finally {
    await app.request("/api/settings/ai-gateway", {
      method: "PUT",
      headers,
      body: JSON.stringify({ provider: "vercel", apiKey: null }),
    });
    await app.request("/api/settings/gitlab-import", {
      method: "PUT",
      headers,
      body: JSON.stringify({ token: "" }),
    });
  }
});
