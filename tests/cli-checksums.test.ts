import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { app } from "../src/server/app";

test("/cli/checksums.json publishes sha256 of the served install payloads", async () => {
  const res = await app.request("/cli/checksums.json");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  const body = await res.json();
  expect(body.algorithm).toBe("sha256");
  for (const path of [
    "cli/skillbox.mjs",
    "cli/package.mjs",
    "bootstrap/SKILL.md",
  ]) {
    const served = await app.request("/" + path);
    expect(served.status).toBe(200);
    const digest = createHash("sha256")
      .update(Buffer.from(await served.arrayBuffer()))
      .digest("hex");
    expect(body.files[path]).toBe(digest);
  }
});
