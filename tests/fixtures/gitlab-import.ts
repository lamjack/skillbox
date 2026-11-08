import { createHash } from "node:crypto";
export const IMPORT_COMMIT = "c".repeat(40);
export const GITLAB_HOST = "gitlab.example.com";
export const GITLAB_TOKEN = "glpat-fixture-token";
export function gitlabFixture(
  id = "example",
  options: {
    prefix?: string;
    secret?: boolean;
    mode?: string;
    type?: string;
    oversized?: boolean;
    corrupt?: boolean;
    secondPage?: boolean;
  } = {},
) {
  const prefix = options.prefix ?? "skills/example/";
  const files = [
    {
      path: prefix + "SKILL.md",
      bytes: Buffer.from(
        `---\nname: ${id}\ndescription: Fixture skill\n---\nRead instructions.\n`,
      ),
      mode: "100644",
      type: "blob",
    },
    {
      path: prefix + "scripts/run.sh",
      bytes: Buffer.from(
        options.secret
          ? "ghp_" + "x".repeat(36)
          : "#!/bin/sh\nprintf never-run\n",
      ),
      mode: options.mode ?? "100755",
      type: options.type ?? "blob",
    },
    {
      path: prefix + "assets/data.bin",
      bytes: Buffer.from([0, 255, 2]),
      mode: "100644",
      type: "blob",
    },
    {
      path: prefix + ".env",
      bytes: Buffer.from("EXAMPLE=private"),
      mode: "100644",
      type: "blob",
    },
  ];
  const treeEntry = (file: (typeof files)[number]) => ({
    id: createHash("sha1")
      .update(`blob ${file.bytes.length}\0`)
      .update(file.bytes)
      .digest("hex"),
    name: file.path.split("/").at(-1),
    type: file.type,
    path: file.path,
    mode: file.mode,
  });
  const requests: string[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (init?.redirect !== "error")
      throw new Error("Redirects must be rejected");
    if (url.hostname !== GITLAB_HOST)
      throw new Error(`Unexpected host ${url.hostname}`);
    if (
      new Headers(init?.headers).get("PRIVATE-TOKEN") !== GITLAB_TOKEN
    )
      return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    const project = "/api/v4/projects/" + encodeURIComponent("fixture/skills");
    if (url.pathname === project)
      return Response.json({ default_branch: "main" });
    if (url.pathname.includes("/repository/commits/")) {
      const ref = decodeURIComponent(
        url.pathname.split("/repository/commits/")[1],
      );
      return ["main", "feature/import", IMPORT_COMMIT].includes(ref)
        ? Response.json({ id: IMPORT_COMMIT })
        : Response.json({ message: "404 Commit Not Found" }, { status: 404 });
    }
    if (url.pathname.endsWith("/repository/tree")) {
      const entries = files.map(treeEntry);
      const page = Number(url.searchParams.get("page") ?? "1");
      if (options.secondPage && page === 1)
        return Response.json(entries.slice(0, 2), {
          headers: { "x-next-page": "2" },
        });
      const slice =
        options.secondPage && page === 2 ? entries.slice(2) : entries;
      return Response.json(options.secondPage && page > 2 ? [] : slice);
    }
    if (url.pathname.includes("/repository/files/")) {
      const path = decodeURIComponent(
        url.pathname
          .split("/repository/files/")[1]
          .replace(/\/raw$/, ""),
      );
      const file = files.find((file) => file.path === path);
      if (!file) return new Response("Not found", { status: 404 });
      const bytes = options.corrupt
        ? Buffer.concat([file.bytes, Buffer.from("tampered")])
        : file.bytes;
      return new Response(
        options.oversized ? Buffer.alloc(2_000_001) : bytes,
      );
    }
    return new Response("Unexpected URL", { status: 404 });
  }) as typeof fetch;
  return { fetcher, requests, files };
}
