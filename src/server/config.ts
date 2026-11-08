export const appOrigin = () =>
  process.env.SKILLBOX_ORIGIN ?? "http://127.0.0.1:4791";

// Explicit deployment configuration only. No trusted personal hostnames ship in source.
export function allowedOrigins() {
  const origins = [
    appOrigin(),
    ...(process.env.SKILLBOX_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
  ];
  return new Set(
    origins.map((value) => {
      const url = new URL(value.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error("Invalid configured origin");
      return url.origin;
    }),
  );
}
export function executorResourceAliases(): Record<string, string> {
  const value: unknown = JSON.parse(
    process.env.SKILLBOX_EXECUTOR_RESOURCE_ALIASES || "{}",
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Executor resource aliases");
  for (const [endpoint, resource] of Object.entries(value)) {
    for (const item of [endpoint, resource]) {
      if (typeof item !== "string")
        throw new Error("Invalid Executor resource alias");
      const url = new URL(item);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid Executor resource alias");
    }
  }
  return value as Record<string, string>;
}

// Bare hostname like gitlab.example.com or gitlab.example.com:8443; https only.
const gitlabHostShape = /^[a-z0-9.-]+(?::(\d{1,5}))?$/i;
export function gitlabHost(): string | null {
  const raw = process.env.SKILLBOX_GITLAB_HOST?.trim().toLowerCase();
  if (!raw) return null;
  const match = gitlabHostShape.exec(raw);
  const port = match?.[1] !== undefined ? Number(match[1]) : null;
  if (
    !match ||
    raw.startsWith(".") ||
    raw.endsWith(".") ||
    raw.includes("..") ||
    (port !== null && (port < 1 || port > 65535))
  )
    throw new Error(
      "SKILLBOX_GITLAB_HOST must be a bare hostname with an optional port, e.g. gitlab.example.com:8443",
    );
  return raw;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export function importMaxFiles(): number {
  return envPositiveInt("SKILLBOX_IMPORT_MAX_FILES", 400);
}

export function importMaxBytes(): number {
  return envPositiveInt("SKILLBOX_IMPORT_MAX_BYTES", 8_000_000);
}

export function importMaxFileBytes(): number {
  return envPositiveInt("SKILLBOX_IMPORT_MAX_FILE_BYTES", 2_000_000);
}

export function importBatchTimeoutMs(): number {
  return envPositiveInt("SKILLBOX_IMPORT_BATCH_TIMEOUT_MS", 180_000);
}

export function mcpResourceMaxBytes(): number {
  return envPositiveInt("SKILLBOX_MCP_RESOURCE_MAX_BYTES", 8_000_000);
}

export function readFileMaxBytes(): number {
  return envPositiveInt("SKILLBOX_READ_FILE_MAX_BYTES", 160_000);
}

// Publishing sends base64 (4/3 overhead) plus JSON framing; the body limit
// follows the configured skill size unless set explicitly.
export function requestBodyMaxBytes(): number {
  return envPositiveInt(
    "SKILLBOX_REQUEST_BODY_MAX_BYTES",
    Math.max(12_000_000, Math.ceil(importMaxBytes() * 1.4) + 1_000_000),
  );
}

export function megabytes(bytes: number): string {
  const value = bytes / 1_000_000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}

export function importLimitMessage(): string {
  return `Imports are limited to ${importMaxFiles()} files and ${megabytes(importMaxBytes())} per skill`;
}
