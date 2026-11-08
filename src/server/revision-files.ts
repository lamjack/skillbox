import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { db } from "./db";
import { blobs, proposalFiles, revisionFiles } from "./schema";
import type { SkillFile } from "../shared";

// Accepts either the database handle or a transaction.
type Tx = Pick<typeof db, "select" | "insert" | "execute">;

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
export const loadProposalFiles = (tx: Tx, proposalId: string) =>
  loadOwned(tx, "proposal", proposalId);

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
    await tx
      .insert(blobs)
      .values(
        chunk.map((f) => ({
          sha256: f.sha256,
          size: f.size,
          content: Buffer.from(f.content, "base64"),
        })),
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
