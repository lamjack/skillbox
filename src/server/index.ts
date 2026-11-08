import { loadRuntimeSecrets } from "./runtime-env";
loadRuntimeSecrets();
const { migrate } = await import("./db");
const { app } = await import("./app");
const { requestBodyMaxBytes } = await import("./config");
if (
  !process.env.SKILLBOX_ADMIN_TOKEN ||
  process.env.SKILLBOX_ADMIN_TOKEN.length < 32
)
  throw new Error("Set SKILLBOX_ADMIN_TOKEN to at least 32 random characters");
await migrate();
const server = Bun.serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4791),
  idleTimeout: 60,
  maxRequestBodySize: requestBodyMaxBytes(),
});
console.log(`Skillbox listening on ${server.hostname}:${server.port}`);
