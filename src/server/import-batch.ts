import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { skills } from "./schema";
import { Problem, publish } from "./library";
import { importBatchTimeoutMs } from "./config";
import type { Principal } from "../shared";
import type { GitHubSource, GitLabSource, SkillFile } from "../shared";

export const importBatchInput = z
  .object({
    url: z.string().min(1).max(2048),
    items: z
      .array(
        z
          .object({
            path: z.string().max(1000),
            id: z.string().min(1).max(80),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    overwrite: z.boolean(),
  })
  .strict();

type BatchOpen<Ctx> = (url: string, signal: AbortSignal) => Promise<{
  release: () => void;
  repository: string;
  commit: string;
  ref?: string;
  candidates: string[];
  ctx: Ctx;
}>;
type BatchAssemble<Ctx> = (
  ctx: Ctx,
  path: string,
  signal: AbortSignal,
) => Promise<{
  id: string;
  files: SkillFile[];
  source: GitHubSource | GitLabSource;
}>;

export async function runImportBatch<Ctx>(
  input: unknown,
  principal: Principal,
  open: BatchOpen<Ctx>,
  assemble: BatchAssemble<Ctx>,
) {
  const args = importBatchInput.parse(input);
  const signal = AbortSignal.timeout(importBatchTimeoutMs());
  const batch = await open(args.url, signal);
  const results: {
    path: string;
    id: string;
    status: "created" | "updated" | "skipped" | "conflict" | "error";
    revision?: string;
    message?: string;
  }[] = [];
  try {
    for (const item of args.items) {
      try {
        if (!batch.candidates.includes(item.path))
          throw new Problem(
            400,
            "Choose a skill directory from this repository or folder",
          );
        signal.throwIfAborted();
        const prepared = await assemble(batch.ctx, item.path, signal);
        if (prepared.id !== item.id)
          throw new Problem(
            400,
            `SKILL.md declares "${prepared.id}", expected "${item.id}"`,
          );
        const [existing] = await db
          .select({
            revision: skills.revision,
            kind: skills.kind,
            disabled: skills.disabled,
            archived: skills.archived,
          })
          .from(skills)
          .where(eq(skills.id, item.id));
        if (
          existing &&
          (existing.kind !== "skill" ||
            existing.disabled ||
            existing.archived)
        )
          throw new Problem(
            409,
            "Existing entry is a bundle, disabled or archived; resolve that before importing",
          );
        if (existing && !args.overwrite) {
          results.push({ ...item, status: "skipped" });
          continue;
        }
        const published = await publish(
          principal,
          item.id,
          prepared.files,
          existing?.revision ?? null,
          `Import ${batch.repository}@${batch.commit.slice(0, 12)}`,
          undefined,
          { source: prepared.source },
        );
        results.push({
          ...item,
          status: existing ? "updated" : "created",
          revision: published.revision,
        });
      } catch (error) {
        results.push({
          ...item,
          status:
            error instanceof Problem && error.status === 409
              ? "conflict"
              : "error",
          message: (error as Error).message,
        });
      }
    }
  } finally {
    batch.release();
  }
  return {
    source: {
      repository: batch.repository,
      commit: batch.commit,
      ...(batch.ref ? { ref: batch.ref } : {}),
    },
    results,
  };
}
