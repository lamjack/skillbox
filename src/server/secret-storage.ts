import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { connection } from "./db";

export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

const V2 = "v2:";
const SALT_ROW_ID = "crypto_salt";

const token = () => {
  const value = process.env.SKILLBOX_ADMIN_TOKEN;
  if (!value || value.length < 32)
    throw new Error("A strong SKILLBOX_ADMIN_TOKEN is required");
  return value;
};

let saltCache: Buffer | undefined;
async function salt(): Promise<Buffer> {
  if (saltCache) return saltCache;
  const [row] =
    await connection`SELECT value FROM workspace_settings WHERE id=${SALT_ROW_ID}`;
  if (!row) {
    const generated = randomBytes(16);
    await connection`INSERT INTO workspace_settings(id, value) VALUES (${SALT_ROW_ID}, ${JSON.stringify({ salt: generated.toString("base64") })}::jsonb) ON CONFLICT(id) DO NOTHING`;
  }
  const [stored] =
    await connection`SELECT value FROM workspace_settings WHERE id=${SALT_ROW_ID}`;
  saltCache = Buffer.from((stored.value as { salt: string }).salt, "base64");
  return saltCache;
}

// Re-derives when the configured token changes instead of silently unsealing.
let keyCache: { token: string; salt: Buffer; key: Buffer } | undefined;
async function key(): Promise<Buffer> {
  const value = token();
  const s = await salt();
  if (keyCache?.token === value && keyCache.salt.equals(s)) return keyCache.key;
  const derived = scryptSync(value, s, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  keyCache = { token: value, salt: s, key: derived };
  return derived;
}
const legacyKey = () => createHash("sha256").update(token()).digest();

function encrypt(key: Buffer, value: unknown, prefix = ""): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: prefix + bytes.toString("base64"),
  };
}
function decrypt(key: Buffer, value: Sealed, prefix = ""): unknown {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(value.data.slice(prefix.length), "base64")),
      decipher.final(),
    ]).toString(),
  );
}

export async function seal(value: unknown): Promise<Sealed> {
  return encrypt(await key(), value, V2);
}
export async function open(
  value: Sealed,
  settingsId?: string,
): Promise<unknown> {
  if (value.data.startsWith(V2)) return decrypt(await key(), value, V2);
  try {
    return decrypt(await key(), value);
  } catch {
    // Unprefixed values that fail the v2 key are legacy ciphertexts.
  }
  const plaintext = decrypt(legacyKey(), value);
  if (settingsId) {
    const resealed = encrypt(await key(), plaintext, V2);
    await connection`UPDATE workspace_settings SET value=${JSON.stringify(resealed)}::jsonb WHERE id=${settingsId}`;
    console.info(
      `secret-storage: re-sealed legacy ciphertext for "${settingsId}"`,
    );
  }
  return plaintext;
}
