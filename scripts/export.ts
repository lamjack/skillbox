import {
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  lstat,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { db, connection, migrate } from "../src/server/db";
import { skills } from "../src/server/schema";
import {
  ADMIN,
  listRevisionFiles,
  revisionRow,
  safePath,
  validId,
} from "../src/server/library";
import { loadFiles } from "../src/server/revision-files";
await migrate();
const dest = resolve(process.env.SKILLBOX_EXPORT_DIR ?? "data/export");
await mkdir(dest, { recursive: true, mode: 0o700 });
const marker = join(dest, ".skillbox-export");
try {
  await readFile(marker);
} catch {
  if ((await readdir(dest)).some((n) => n !== ".git"))
    throw new Error(
      "Export destination must be empty or a previous Skillbox export",
    );
  await writeFile(marker, "Skillbox managed native skill export\n");
}
const manifest = [];
const sections = ["skills", "archive", "disabled"];
for (const section of sections)
  await mkdir(join(dest, section), { recursive: true });
for (const s of await db.select().from(skills)) {
  validId(s.id);
  const r = await revisionRow(ADMIN, s.id);
  const section = s.archived ? "archive" : s.disabled ? "disabled" : "skills";
  const folder = join(dest, section, s.id);
  for (const other of sections.filter((x) => x !== section))
    await rm(join(dest, other, s.id), { recursive: true, force: true });
  await rm(folder, { recursive: true, force: true });
  // One file at a time: large skills never sit fully in memory.
  for (const entry of await listRevisionFiles(r.id)) {
    safePath(entry.path);
    const [f] = await loadFiles(db, r.id, [entry.path]);
    const path = join(folder, entry.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(f.content, "base64"), {
      mode: f.executable ? 0o700 : 0o600,
    });
  }
  manifest.push({
    id: s.id,
    referenceId: s.referenceId,
    revision: r.id,
    checksum: r.checksum,
    kind: s.kind,
    archived: s.archived,
    disabled: s.disabled,
    replacement: s.replacement,
    members: s.members,
  });
}
await writeFile(
  join(dest, "manifest.json"),
  JSON.stringify({ format: "skillbox-export/v1", skills: manifest }, null, 2),
);
if (process.argv.includes("--push")) {
  const git = async (args: string[]) => {
    const p = Bun.spawn(["git", "-C", dest, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    if (code) throw new Error("Export git command failed: " + args[0]);
    return await new Response(p.stdout).text();
  };
  await git(["rev-parse", "--git-dir"]);
  await git([
    "add",
    "skills",
    "archive",
    "disabled",
    "manifest.json",
    ".skillbox-export",
  ]);
  const changed = await git(["status", "--porcelain"]);
  if (changed.trim())
    await git(["commit", "-m", "Export published Skillbox library"]);
  await git(["push"]);
}
console.log(
  JSON.stringify({
    exported: manifest.length,
    destination: dest,
    pushed: process.argv.includes("--push"),
  }),
);
await connection.end();
