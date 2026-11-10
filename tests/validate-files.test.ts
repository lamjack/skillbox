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

const skill = makeFile(
  "SKILL.md",
  "---\nname: example\ndescription: Fixture skill\n---\nBody",
);
const withContent = (content: string, size: number) => [
  skill,
  {
    ...makeFile("assets/a.bin", Buffer.from(content, "base64")),
    content,
    size,
  },
];

test("validateFiles rejects non-canonical base64", () => {
  for (const content of [
    "YQ",
    "YR==",
    "YWJ=",
    "YW Jj",
    "YWJj\n",
    "-_-_",
    "ab$=",
    "YQ===",
    "=YWJ",
    "Y=Jj",
  ])
    expect(() =>
      validateFiles(
        withContent(content, Buffer.from(content, "base64").length),
      ),
    ).toThrow(/Invalid file encoding|File checksum mismatch/);
  expect(() => validateFiles(withContent("", 0))).not.toThrow();
  expect(() => validateFiles(withContent("YQ==", 1))).not.toThrow();
  expect(() => validateFiles(withContent("YWI=", 2))).not.toThrow();
  expect(() => validateFiles(withContent("+/+/", 3))).not.toThrow();
});

test("validateFiles rejects size and digest mismatches", () => {
  const [, file] = withContent("YWJj", 3);
  expect(() => validateFiles([skill, { ...file, size: 4 }])).toThrow(
    "File checksum mismatch",
  );
  expect(() =>
    validateFiles([skill, { ...file, sha256: "0".repeat(64) }]),
  ).toThrow("File checksum mismatch");
});

// Re-encoding every file doubled import memory and OOM-killed large imports.
test("validateFiles does not re-encode file content", () => {
  const files = [skill, makeFile("assets/big.bin", Buffer.alloc(1_000_000, 7))];
  const original = Buffer.prototype.toString;
  let encodes = 0;
  Buffer.prototype.toString = function (this: Buffer, ...args: unknown[]) {
    if (args[0] === "base64") encodes++;
    return (original as (...a: unknown[]) => string).apply(this, args);
  } as typeof original;
  try {
    validateFiles(files);
  } finally {
    Buffer.prototype.toString = original;
  }
  expect(encodes).toBe(0);
});
