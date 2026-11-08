import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm, lstat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
export const hash = (v) => createHash("sha256").update(v).digest("hex");
// Structural and checksum verification shared by inline bundles and
// listings; file bytes are checked separately as they become available.
export function verifyListing(bundle) {
  if (
    !["skillbox/v1", "skillbox/v1-listing"].includes(bundle?.format) ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(bundle.id) ||
    !/^[-a-zA-Z0-9]{1,100}$/.test(bundle.revision) ||
    !Array.isArray(bundle.files) ||
    !bundle.files.length
  )
    throw new Error("Invalid package");
  const seen = new Set();
  for (const f of bundle.files) {
    if (
      typeof f.path !== "string" ||
      f.path.length > 240 ||
      f.path.startsWith("/") ||
      f.path.includes("\\") ||
      /[\x00-\x1f:]/.test(f.path) ||
      f.path.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new Error("Unsafe package path");
    const key = f.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate package path");
    seen.add(key);
    if (
      !/^[0-9a-f]{64}$/.test(f.sha256) ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      typeof f.executable !== "boolean"
    )
      throw new Error("Invalid package entry");
  }
  if (!bundle.files.some((f) => f.path === "SKILL.md"))
    throw new Error("Package is missing SKILL.md");
  for (const p of seen)
    for (const q of seen)
      if (q.startsWith(p + "/")) throw new Error("Package path collision");
  const checksum = hash(
    JSON.stringify(
      [...bundle.files]
        .sort((a, b) => a.path.localeCompare(b.path, "en-US"))
        .map((f) => [f.path, f.sha256, f.executable]),
    ),
  );
  if (checksum !== bundle.checksum)
    throw new Error("Package checksum mismatch");
  return bundle.files;
}
export function verifyFileBytes(f, bytes) {
  if (bytes.length !== f.size || hash(bytes) !== f.sha256)
    throw new Error("Package integrity check failed");
  return bytes;
}
export function verifyBundle(bundle) {
  return verifyListing(bundle).map((f) => {
    if (typeof f.content !== "string")
      throw new Error("Package integrity check failed");
    const bytes = Buffer.from(f.content, "base64");
    if (bytes.toString("base64") !== f.content)
      throw new Error("Package integrity check failed");
    return { ...f, bytes: verifyFileBytes(f, bytes) };
  });
}
// bytesFor(file) returns the verified bytes of one entry; files are written
// one at a time so memory stays per-file, not per-package.
export async function materializeWith(bundle, root, bytesFor) {
  const files = verifyListing(bundle);
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Cache root cannot be a symlink");
  const target = join(root, `${bundle.id}-${bundle.revision}`),
    tmp = join(root, ".download-" + randomUUID());
  await mkdir(tmp, { mode: 0o700 });
  try {
    for (const f of files) {
      const dest = join(tmp, f.path);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, verifyFileBytes(f, await bytesFor(f)), {
        mode: f.executable ? 0o700 : 0o600,
        flag: "wx",
      });
    }
    try {
      await rename(tmp, target);
    } catch (e) {
      if (e.code === "ENOTEMPTY" || e.code === "EEXIST") {
        /* Never trust an existing mutable cache directory: return this freshly verified copy. */ const fresh =
          target + "-" + randomUUID();
        await rename(tmp, fresh);
        return fresh;
      }
      throw e;
    }
    return target;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
export function materialize(bundle, root) {
  const verified = new Map(verifyBundle(bundle).map((f) => [f.path, f.bytes]));
  return materializeWith(bundle, root, (f) => verified.get(f.path));
}
