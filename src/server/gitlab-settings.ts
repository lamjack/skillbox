import { randomUUID } from "node:crypto";
import { z } from "zod";
import { gitlabHost } from "./config";
import { connection } from "./db";
import { seal, openStored, UNREADABLE } from "./secret-storage";
import type { SecretState } from "./secret-storage";
import { Problem } from "./library";

const configSchema = z.object({
  revision: z.string(),
  host: z.string().nullable().optional(), // legacy field from env-era rows
  token: z.string().nullable().default(null),
  updatedAt: z.string().optional(),
});
export const gitlabTokenInput = z
  .object({
    token: z
      .string()
      .trim()
      .max(512)
      .regex(/^\S*$/, "Token must not contain whitespace"),
  })
  .strict();
type Config = z.output<typeof configSchema>;

async function decode(value?: unknown): Promise<Config | null> {
  if (!value) return null;
  const opened = await openStored(
    value as Parameters<typeof openStored>[0],
    "gitlab_import",
  );
  return opened === UNREADABLE ? null : configSchema.parse(opened);
}
async function secretState(value?: unknown): Promise<SecretState> {
  return value &&
    (await openStored(
      value as Parameters<typeof openStored>[0],
      "gitlab_import",
    )) === UNREADABLE
    ? "unreadable"
    : "readable";
}
export async function gitlabImportToken(): Promise<string | null> {
  const [row] =
    await connection`SELECT value FROM workspace_settings WHERE id='gitlab_import'`;
  return (await decode(row?.value))?.token ?? null;
}
export async function gitlabImportSettings() {
  const [row] =
    await connection`SELECT value FROM workspace_settings WHERE id='gitlab_import'`;
  const config = await decode(row?.value);
  return {
    host: gitlabHost(),
    configured: !!config?.token,
    secretState: await secretState(row?.value),
    updatedAt: config?.updatedAt ?? null,
  };
}
export async function configureGitLabImport(
  input: z.input<typeof gitlabTokenInput>,
) {
  const update = gitlabTokenInput.parse(input);
  await connection.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('skillbox-gitlab-import'))`;
    const [row] =
      await tx`SELECT value FROM workspace_settings WHERE id='gitlab_import'`;
    const config = (await decode(row?.value)) ?? {
      revision: "",
      token: null,
    };
    if (!update.token) {
      await tx`DELETE FROM workspace_settings WHERE id='gitlab_import'`;
      return;
    }
    if (config.token === update.token) return;
    config.revision = randomUUID();
    config.token = update.token;
    config.updatedAt = new Date().toISOString();
    delete config.host;
    await tx`INSERT INTO workspace_settings(id,value) VALUES ('gitlab_import',${JSON.stringify(await seal(config))}::jsonb) ON CONFLICT(id) DO UPDATE SET value=excluded.value`;
  });
  return gitlabImportSettings();
}
