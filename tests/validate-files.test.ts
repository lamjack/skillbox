import { test, expect } from "bun:test";
import { makeFile, validateFiles } from "../src/server/library";

test("publish limits follow SKILLBOX_IMPORT_MAX_* environment settings", () => {
  const savedFiles = process.env.SKILLBOX_IMPORT_MAX_FILES;
  const savedBytes = process.env.SKILLBOX_IMPORT_MAX_BYTES;
  const savedFileBytes = process.env.SKILLBOX_IMPORT_MAX_FILE_BYTES;
  const files = [
    makeFile(
      "SKILL.md",
      "---\nname: example\ndescription: Fixture skill\n---\nBody",
    ),
    makeFile("references/a.md", "x".repeat(150_000)),
    makeFile("references/b.md", "y".repeat(150_000)),
  ];
  try {
    process.env.SKILLBOX_IMPORT_MAX_FILES = "2";
    process.env.SKILLBOX_IMPORT_MAX_BYTES = "400000000";
    expect(() => validateFiles(files)).toThrow("Expected 1–2 files");
    process.env.SKILLBOX_IMPORT_MAX_FILES = "3";
    process.env.SKILLBOX_IMPORT_MAX_BYTES = "200000";
    expect(() => validateFiles(files)).toThrow(
      "Skill is limited to 0.2 MB",
    );
    process.env.SKILLBOX_IMPORT_MAX_BYTES = "400000";
    expect(() => validateFiles(files)).not.toThrow();
    process.env.SKILLBOX_IMPORT_MAX_FILE_BYTES = "100000";
    expect(() => validateFiles(files)).toThrow(
      "Files are limited to 0.1 MB",
    );
    process.env.SKILLBOX_IMPORT_MAX_FILE_BYTES = "200000";
    expect(() => validateFiles(files)).not.toThrow();
    process.env.SKILLBOX_IMPORT_MAX_FILE_BYTES = "50000000";
    process.env.SKILLBOX_IMPORT_MAX_BYTES = "400000000";
    expect(() =>
      validateFiles([
        makeFile(
          "SKILL.md",
          "---\nname: example\ndescription: Fixture skill\n---\nBody",
        ),
        makeFile("assets/big.bin", Buffer.alloc(4_000_000)),
      ]),
    ).not.toThrow();
  } finally {
    if (savedFiles === undefined) delete process.env.SKILLBOX_IMPORT_MAX_FILES;
    else process.env.SKILLBOX_IMPORT_MAX_FILES = savedFiles;
    if (savedBytes === undefined) delete process.env.SKILLBOX_IMPORT_MAX_BYTES;
    else process.env.SKILLBOX_IMPORT_MAX_BYTES = savedBytes;
    if (savedFileBytes === undefined)
      delete process.env.SKILLBOX_IMPORT_MAX_FILE_BYTES;
    else process.env.SKILLBOX_IMPORT_MAX_FILE_BYTES = savedFileBytes;
  }
});
