import type { SkillFile } from "./shared";
export const isIconAsset = (path: string) =>
  /^assets\/skillbox-icon\.(png|webp|jpeg)$/.test(path);
export const PACKAGE_BANDS = [
  {
    label: "Light",
    files: 1,
    chars: 2000,
    bytes: 10000,
    range: "1 file · ≤2k chars",
  },
  {
    label: "Compact",
    files: 3,
    chars: 10000,
    bytes: 100000,
    range: "≤3 files · ≤10k chars",
  },
  {
    label: "Moderate",
    files: 10,
    chars: 30000,
    bytes: 500000,
    range: "≤10 files · ≤30k chars",
  },
  {
    label: "Heavy",
    files: 25,
    chars: 75000,
    bytes: 1000000,
    range: "≤25 files · ≤75k chars",
  },
  {
    label: "Very heavy",
    files: Infinity,
    chars: Infinity,
    bytes: Infinity,
    range: ">25 files, >75k chars or >1 MB",
  },
];
export function packageBand(m: {
  fileCount?: number;
  characters?: number;
  packageBytes?: number;
}) {
  return PACKAGE_BANDS.findIndex(
    (b) =>
      (m.fileCount ?? 0) <= b.files &&
      (m.characters ?? 0) <= b.chars &&
      (m.packageBytes ?? 0) <= b.bytes,
  );
}
export function packageMetrics(files: SkillFile[]) {
  let characters = 0,
    packageBytes = 0,
    fileCount = 0,
    entryCharacters = 0;
  for (const f of files) {
    if (isIconAsset(f.path)) continue;
    fileCount++;
    packageBytes += f.size;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(f.content, "base64"),
      );
      if (text.includes("\0")) continue;
      const n = Array.from(text).length;
      characters += n;
      if (f.path === "SKILL.md") entryCharacters = n;
    } catch {
      /* binary assets count toward bytes/files, not text */
    }
  }
  return { characters, packageBytes, fileCount, entryCharacters };
}

// Assets that never contribute text to metadata, search or package metrics;
// they are verified by digest and their bytes stay in the blob store.
export const BINARY_EXTENSIONS =
  /\.(pdf|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|zip|gz|tgz|bz2|xz|7z|rar|jar|woff2?|ttf|otf|eot|mp[34]|m4[av]|mov|avi|mkv|webm|wav|ogg|flac|docx?|xlsx?|pptx?|bin|exe|dll|so|dylib|wasm|sqlite|db)$/i;
