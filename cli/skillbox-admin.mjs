#!/usr/bin/env node
// Owner-scoped Skillbox administration over stdio JSON-RPC (dependency-free).
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

function die(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

const configPath =
  process.env.SKILLBOX_ADMIN_CONFIG ??
  join(homedir(), ".config/skillbox/admin.json");
const st = await stat(configPath).catch((e) =>
  die(`Cannot read ${configPath}: ${e.message}`),
);
if (!st.isFile() || (st.mode & 0o777) !== 0o600)
  die(`Refusing to start: ${configPath} must be mode 0600`);
const config = JSON.parse(await readFile(configPath, "utf8"));
const base = String(config.url ?? "").replace(/\/$/, "");
const token = config.token;
if (!base || typeof token !== "string" || !token)
  die("admin.json must contain url and token");

async function request(method, path, body) {
  const r = await fetch(base + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!r.ok)
    throw new Error(
      typeof data?.error === "string" ? data.error : `HTTP ${r.status}`,
    );
  return data;
}

function truncate(value) {
  if (typeof value === "string")
    return value.length > 4096 ? value.slice(0, 4096) + "… [truncated]" : value;
  if (Array.isArray(value)) return value.map(truncate);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, truncate(v)]),
    );
  return value;
}

const enc = encodeURIComponent;
const str = (o = {}) => ({ type: "string", ...o });
const bool = () => ({ type: "boolean" });
const obj = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: "list_skills",
    description: "List skills (and bundles) with optional text filter.",
    inputSchema: obj({ query: str(), includeBundles: bool() }),
    run: ({ query, includeBundles }) =>
      request(
        "GET",
        "/api/skills?" +
          new URLSearchParams({
            kind: includeBundles === false ? "skill" : "all",
            ...(query ? { query } : {}),
          }),
      ),
  },
  {
    name: "get_skill",
    description: "Get one skill or bundle by ID.",
    inputSchema: obj({ id: str() }, ["id"]),
    run: ({ id }) => request("GET", `/api/skills/${enc(id)}`),
  },
  {
    name: "set_skill_status",
    description:
      "Enable, disable or archive a skill. Archives are not reversible through this tool.",
    inputSchema: obj(
      { id: str(), status: { type: "string", enum: ["enabled", "disabled", "archived"] } },
      ["id", "status"],
    ),
    run: async ({ id, status }) => {
      const skill = await request("GET", `/api/skills/${enc(id)}`);
      if (status === "archived")
        return request("DELETE", `/api/skills/${enc(id)}`, {
          expectedRevision: skill.revision,
        });
      return request("PATCH", `/api/skills/${enc(id)}/status`, {
        disabled: status === "disabled",
        expectedRevision: skill.revision,
      });
    },
  },
  {
    name: "upsert_bundle",
    description: "Create or update a bundle's members, title and description.",
    inputSchema: obj(
      {
        id: str(),
        name: str(),
        description: str(),
        members: { type: "array", items: str() },
      },
      ["id", "members"],
    ),
    run: async ({ id, name, description, members }) => {
      const existing = await request("GET", `/api/skills/${enc(id)}`).catch(
        () => null,
      );
      return request("PUT", `/api/bundles/${enc(id)}`, {
        title: name ?? existing?.title ?? id,
        description: description ?? existing?.description ?? "",
        members,
        expectedRevision: existing?.revision ?? null,
      });
    },
  },
  {
    name: "list_profiles",
    description: "List access profiles.",
    inputSchema: obj(),
    run: () => request("GET", "/api/profiles"),
  },
  {
    name: "create_profile",
    description: "Create an access profile.",
    inputSchema: obj(
      {
        name: str(),
        grants: { type: "array", items: str() },
        allSkills: bool(),
        permissions: obj(
          {
            create: bool(),
            update: bool(),
            archive: bool(),
            proposal: bool(),
          },
          ["create", "update", "archive", "proposal"],
        ),
      },
      ["name", "grants", "permissions"],
    ),
    run: ({ name, grants, allSkills, permissions }) =>
      request("POST", "/api/profiles", {
        name,
        allSkills: allSkills ?? false,
        skillIds: grants,
        permissions: {
          create: permissions.create,
          update: permissions.update,
          delete: permissions.archive,
          propose: permissions.proposal,
        },
      }),
  },
  {
    name: "update_profile",
    description: "Update an access profile; omitted fields keep current values.",
    inputSchema: obj(
      {
        id: str(),
        name: str(),
        grants: { type: "array", items: str() },
        allSkills: bool(),
        permissions: obj({
          create: bool(),
          update: bool(),
          archive: bool(),
          proposal: bool(),
        }),
      },
      ["id"],
    ),
    run: async ({ id, name, grants, allSkills, permissions }) => {
      const current = (await request("GET", "/api/profiles")).find(
        (p) => p.id === id,
      );
      if (!current) throw new Error(`Profile ${id} not found`);
      const perms = permissions ?? {
        create: current.permissions.create,
        update: current.permissions.update,
        archive: current.permissions.delete,
        proposal: current.permissions.propose,
      };
      return request("PUT", `/api/profiles/${enc(id)}`, {
        name: name ?? current.name,
        allSkills: allSkills ?? current.allSkills,
        skillIds: grants ?? current.skillIds,
        permissions: {
          create: perms.create,
          update: perms.update,
          delete: perms.archive,
          propose: perms.proposal,
        },
        version: current.version,
      });
    },
  },
  {
    name: "delete_profile",
    description: "Delete an access profile (refuses while clients reference it).",
    inputSchema: obj({ id: str() }, ["id"]),
    run: ({ id }) => request("DELETE", `/api/profiles/${enc(id)}`),
  },
  {
    name: "list_clients",
    description: "List MCP clients.",
    inputSchema: obj(),
    run: () => request("GET", "/api/clients"),
  },
  {
    name: "create_client",
    description: "Create an MCP client and return its one-time key.",
    inputSchema: obj({ name: str(), profileId: str() }, ["name", "profileId"]),
    run: async ({ name, profileId }) => {
      const created = await request("POST", "/api/clients", {
        name,
        profileId,
      });
      return { __prepend: "Key shown once; store it now.", ...created };
    },
  },
  {
    name: "update_client",
    description: "Rename, re-profile or revoke an MCP client.",
    inputSchema: obj(
      {
        id: str(),
        name: str(),
        profileId: str(),
        revoked: bool(),
      },
      ["id"],
    ),
    run: ({ id, name, profileId, revoked }) =>
      request("PATCH", `/api/clients/${enc(id)}`, {
        ...(name !== undefined ? { name } : {}),
        ...(profileId !== undefined ? { profileId } : {}),
        ...(revoked !== undefined ? { active: !revoked } : {}),
      }),
  },
  {
    name: "import_preview",
    description: "Preview a GitHub or GitLab import without publishing.",
    inputSchema: obj(
      {
        source: { type: "string", enum: ["github", "gitlab"] },
        url: str(),
      },
      ["source", "url"],
    ),
    run: ({ source, url }) =>
      request("POST", `/api/imports/${source}/preview`, { url }),
  },
  {
    name: "import_publish_batch",
    description: "Batch-publish skill directories from a repository preview.",
    inputSchema: obj(
      {
        source: { type: "string", enum: ["github", "gitlab"] },
        url: str(),
        items: {
          type: "array",
          items: obj({ path: str(), id: str() }, ["path", "id"]),
        },
        overwrite: bool(),
      },
      ["source", "url", "items"],
    ),
    run: ({ source, url, items, overwrite }) =>
      request("POST", `/api/imports/${source}/publish-batch`, {
        url,
        items,
        overwrite: overwrite ?? false,
      }),
  },
  {
    name: "list_events",
    description: "Page raw usage events (max 100 per page).",
    inputSchema: obj(
      {
        skillId: str(),
        operation: { type: "string", enum: ["reads", "usage", "legacy", "web"] },
        offset: { type: "integer" },
      },
    ),
    run: ({ skillId, operation, offset }) =>
      request(
        "GET",
        "/api/events?" +
          new URLSearchParams({
            ...(skillId ? { skillId } : {}),
            ...(operation ? { operation } : {}),
            ...(offset !== undefined ? { offset: String(offset) } : {}),
          }),
      ),
  },
  {
    name: "usage_summary",
    description: "Aggregated read/usage analytics for active skills.",
    inputSchema: obj({ days: { type: "integer" } }),
    run: async ({ days }) => {
      const data = await request(
        "GET",
        "/api/analytics/usage" +
          (days !== undefined ? `?days=${encodeURIComponent(days)}` : ""),
      );
      const neverRead = data.skills.filter((r) => !r.reads).map((r) => r.id);
      const lines = [
        `Window: last ${data.window.days} days (since ${data.window.since})`,
        `Totals: ${data.totals.skills} skills, ${data.totals.readsInWindow} reads, ${data.totals.usesInWindow} reported uses, ${data.totals.activeClients} active clients`,
        `Top reads: ${data.skills
          .slice(0, 5)
          .map((r) => `${r.id} (${r.reads})`)
          .join(", ") || "none"}`,
        `Never read: ${data.totals.neverRead}`,
        `Never-read ids: ${neverRead.slice(0, 20).join(", ") || "none"}`,
      ];
      return { __prepend: lines.join("\n"), ...data };
    },
  },
  {
    name: "list_proposals",
    description: "List pending skill update proposals.",
    inputSchema: obj(),
    run: () => request("GET", "/api/proposals"),
  },
  {
    name: "get_proposal",
    description: "Get one skill update proposal by ID.",
    inputSchema: obj({ id: str() }, ["id"]),
    run: ({ id }) => request("GET", `/api/proposals/${enc(id)}`),
  },
  {
    name: "review_proposal",
    description: "Approve or reject a skill update proposal.",
    inputSchema: obj(
      {
        id: str(),
        decision: { type: "string", enum: ["approve", "reject"] },
        note: str(),
      },
      ["id", "decision"],
    ),
    run: ({ id, decision }) =>
      request("POST", `/api/proposals/${enc(id)}/review`, { decision }),
  },
  {
    name: "settings_status",
    description:
      "Non-secret configuration status for providers, GitLab import and executor.",
    inputSchema: obj(),
    run: async () => {
      const [gateway, gitlab, executor] = await Promise.all([
        request("GET", "/api/settings/ai-gateway"),
        request("GET", "/api/settings/gitlab-import"),
        request("GET", "/api/settings/executor"),
      ]);
      const providers = {};
      for (const name of ["vercel", "typesafe", "openrouter"]) {
        const p = gateway?.providers?.[name];
        providers[name] = {
          configured: Boolean(p?.configured ?? (gateway?.provider === name && gateway?.configured)),
          updatedAt: p?.updatedAt ?? gateway?.updatedAt?.[name] ?? null,
        };
      }
      return {
        providers,
        gitlab: {
          host: gitlab?.host ?? null,
          configured: Boolean(gitlab?.configured),
        },
        executor: {
          endpoint: executor?.endpoint || null,
          connected: Boolean(executor?.authenticated ?? executor?.connected),
        },
      };
    },
  },
  {
    name: "check_updates",
    description: "Compare imported skills against their remote repositories.",
    inputSchema: obj(),
    run: () => request("POST", "/api/imports/check-updates", {}),
  },
];

const INSTRUCTIONS =
  "Owner-scoped Skillbox administration. Analytics and status tools are read-only. Mutating tools change the live library; confirm intent before bundle/profile/client changes.";

async function call(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const result = await tool.run(args ?? {});
  const prepend = result?.__prepend;
  if (prepend !== undefined) delete result.__prepend;
  const text = JSON.stringify(truncate(result), null, 2);
  return {
    content: [{ type: "text", text: prepend ? prepend + "\n" + text : text }],
  };
}

async function handle(msg) {
  const { method, params } = msg;
  if (method === "initialize")
    return {
      protocolVersion: params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "skillbox-admin", version: "0.1.0" },
      instructions: INSTRUCTIONS,
    };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS.map(({ run, ...t }) => t) };
  if (method === "tools/call") {
    try {
      return await call(params?.name, params?.arguments);
    } catch (e) {
      return {
        content: [{ type: "text", text: String(e?.message ?? e) }],
        isError: true,
      };
    }
  }
  throw { code: -32601, message: `Method not found: ${method}` };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.id === undefined) continue;
  try {
    const result = await handle(msg);
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
    );
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: typeof e?.code === "number" ? e.code : -32000,
          message: String(e?.message ?? e),
        },
      }) + "\n",
    );
  }
}
