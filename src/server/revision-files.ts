import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { db } from "./db";
import { blobs, proposalFiles, revisionFiles } from "./schema";
import type { SkillFile } from "../shared";

// Git blob object ID (`blob <size>\0<bytes>`), matching remote tree entries.
export function gitBlobSha1(bytes: Buffer) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
// Per-revision listing joined with each blob's Git object ID; update checks
// compare this against the remote tree without reading any content.
export const listGitShas = (tx: Tx, revisionId: string) =>
  tx
    .select({ path: revisionFiles.path, gitSha1: blobs.gitSha1 })
    .from(revisionFiles)
    .innerJoin(blobs, eq(blobs.sha256, revisionFiles.sha256))
    .where(eq(revisionFiles.revisionId, revisionId));
// Fills git_sha1 for blobs written before the column existed, one bounded
// batch per call; returns the number of rows updated.
export async function backfillGitShas(tx: Tx, limit = 20) {
  const rows = await tx
    .select({ sha256: blobs.sha256, content: blobs.content })
    .from(blobs)
    .where(isNull(blobs.gitSha1))
    .limit(limit);
  for (const row of rows)
    await tx
      .update(blobs)
      .set({ gitSha1: gitBlobSha1(row.content) })
      .where(eq(blobs.sha256, row.sha256));
  return rows.length;
}

// Accepts either the database handle or a transaction.
type Tx = Pick<typeof db, "select" | "insert" | "update" | "execute">;

// Revisions and proposals keep their file listings in sibling tables that
// share the content-addressed blobs table.
const owners = {
  revision: {
    table: revisionFiles,
    id: revisionFiles.revisionId,
    key: "revisionId" as const,
  },
  proposal: {
    table: proposalFiles,
    id: proposalFiles.proposalId,
    key: "proposalId" as const,
  },
} as const;
type Owner = keyof typeof owners;

async function listOwned(tx: Tx, owner: Owner, ownerId: string) {
  const { table, id } = owners[owner];
  return tx
    .select({
      path: table.path,
      sha256: table.sha256,
      size: table.size,
      executable: table.executable,
    })
    .from(table)
    .where(eq(id, ownerId))
    .orderBy(asc(sql`${table.path} COLLATE "C"`));
}
async function loadOwned(
  tx: Tx,
  owner: Owner,
  ownerId: string,
  paths?: string[],
): Promise<SkillFile[]> {
  if (paths && !paths.length) return [];
  const { table, id } = owners[owner];
  const rows = await tx
    .select({
      path: table.path,
      content: blobs.content,
      sha256: table.sha256,
      size: table.size,
      executable: table.executable,
    })
    .from(table)
    .innerJoin(blobs, eq(blobs.sha256, table.sha256))
    .where(
      paths
        ? and(eq(id, ownerId), inArray(table.path, paths))
        : eq(id, ownerId),
    )
    .orderBy(asc(sql`${table.path} COLLATE "C"`));
  return rows.map((row) => ({
    ...row,
    content: Buffer.from(row.content).toString("base64"),
  }));
}

export const listFiles = (tx: Tx, revisionId: string) =>
  listOwned(tx, "revision", revisionId);
export const loadFiles = (tx: Tx, revisionId: string, paths?: string[]) =>
  loadOwned(tx, "revision", revisionId, paths);
export const loadProposalFiles = (
  tx: Tx,
  proposalId: string,
  paths?: string[],
) => loadOwned(tx, "proposal", proposalId, paths);
export const listProposalFiles = (tx: Tx, proposalId: string) =>
  listOwned(tx, "proposal", proposalId);

const MAX_FILES_PER_STATEMENT = 50;
const MAX_BYTES_PER_STATEMENT = 32 * 1024 * 1024;

export const storeFiles = (tx: Tx, revisionId: string, files: SkillFile[]) =>
  storeOwned(tx, "revision", revisionId, files);
export const storeProposalFiles = (
  tx: Tx,
  proposalId: string,
  files: SkillFile[],
) => storeOwned(tx, "proposal", proposalId, files);

async function storeOwned(
  tx: Tx,
  owner: Owner,
  ownerId: string,
  files: SkillFile[],
) {
  // One statement never carries hundreds of MB of parameters.
  const chunks: SkillFile[][] = [];
  for (const file of files) {
    let chunk = chunks[chunks.length - 1];
    let bytes = chunk?.reduce((sum, f) => sum + f.size, 0) ?? 0;
    if (
      !chunk ||
      chunk.length >= MAX_FILES_PER_STATEMENT ||
      bytes + file.size > MAX_BYTES_PER_STATEMENT
    ) {
      chunk = [];
      chunks.push(chunk);
      bytes = 0;
    }
    chunk.push(file);
  }
  for (const chunk of chunks) {
    // Content-addressed: bytes already stored are never sent again.
    const present = new Set(
      (
        await tx
          .select({ sha256: blobs.sha256 })
          .from(blobs)
          .where(
            inArray(
              blobs.sha256,
              chunk.map((f) => f.sha256),
            ),
          )
      ).map((row) => row.sha256),
    );
    const fresh = chunk.filter((f) => !present.has(f.sha256));
    if (fresh.length)
      await tx
        .insert(blobs)
        .values(
          fresh.map((f) => {
            const content = Buffer.from(f.content, "base64");
            return {
              sha256: f.sha256,
              size: f.size,
              content,
              gitSha1: gitBlobSha1(content),
            };
          }),
        )
        .onConflictDoNothing({ target: blobs.sha256 });
    const { table, key } = owners[owner];
    await tx
      .insert(table)
      .values(
        chunk.map((f) => ({
          [key]: ownerId,
          path: f.path,
          sha256: f.sha256,
          size: f.size,
          executable: f.executable,
        })),
      )
      .onConflictDoNothing();
  }
}
