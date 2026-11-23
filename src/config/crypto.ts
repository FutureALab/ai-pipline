import crypto from "node:crypto";

const ENC_PREFIX = "ENC(";
const ENC_SUFFIX = ")";
const PAYLOAD_VERSION = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const DEFAULT_DEV_MASTER_PASSWORD = "ai-pipeline-default-jasypt-key-change-me";

function resolveMasterPassword(override?: string): string {
  const pwd =
    override?.trim() ||
    process.env.JASYPT_ENCRYPTOR_PASSWORD?.trim() ||
    process.env.APP_CRYPTO_SECRET?.trim() ||
    DEFAULT_DEV_MASTER_PASSWORD;
  return pwd;
}

function deriveKey(masterPassword: string, salt: Buffer): Buffer {
  const staticPepper = process.env.JASYPT_ENCRYPTOR_SALT?.trim();
  const effectiveSalt = staticPepper
    ? Buffer.concat([salt, Buffer.from(staticPepper, "utf-8")])
    : salt;
  return crypto.pbkdf2Sync(
    masterPassword,
    effectiveSalt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha256"
  );
}

/**
 * Returns true if the value is wrapped in Jasypt-style `ENC(...)`.
 */
export function isEncryptedValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    trimmed.startsWith(ENC_PREFIX) &&
    trimmed.endsWith(ENC_SUFFIX) &&
    trimmed.length > ENC_PREFIX.length + ENC_SUFFIX.length
  );
}

/**
 * Jasypt-style salt-based encryption (PBKDF2-HMAC-SHA256 + AES-256-GCM).
 * Produces `ENC(<base64(version[1] + salt[16] + iv[12] + authTag[16] + ciphertext)>)`.
 */
export function encryptSecret(
  plaintext: string,
  masterPassword?: string
): string {
  if (isEncryptedValue(plaintext)) {
    return plaintext.trim();
  }
  const secret = resolveMasterPassword(masterPassword);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(secret, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([
    Buffer.from([PAYLOAD_VERSION]),
    salt,
    iv,
    authTag,
    encrypted,
  ]);
  return `${ENC_PREFIX}${payload.toString("base64")}${ENC_SUFFIX}`;
}

/**
 * Decrypt a Jasypt-style `ENC(...)` ciphertext back to plaintext.
 */
export function decryptSecret(
  ciphertext: string,
  masterPassword?: string
): string {
  const trimmed = ciphertext.trim();
  const inner = isEncryptedValue(trimmed)
    ? trimmed.slice(ENC_PREFIX.length, -ENC_SUFFIX.length).trim()
    : trimmed;

  const raw = Buffer.from(inner, "base64");
  const minLen = 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (raw.length < minLen) {
    throw new Error("Invalid ENC(...) ciphertext payload length");
  }

  const version = raw[0];
  if (version !== PAYLOAD_VERSION) {
    throw new Error(`Unsupported ENC(...) payload version: ${version}`);
  }

  let offset = 1;
  const salt = raw.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = raw.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = raw.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const encrypted = raw.subarray(offset);

  const secret = resolveMasterPassword(masterPassword);
  const key = deriveKey(secret, salt);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}

/**
 * Transparently decrypts `ENC(...)` values; returns plaintext values unchanged.
 */
export function decryptIfEncrypted(
  value: string | null | undefined,
  masterPassword?: string
): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!isEncryptedValue(trimmed)) {
    return trimmed;
  }
  return decryptSecret(trimmed, masterPassword);
}

/**
 * Decrypts a connection URL where either the entire URL or the embedded password
 * segment is wrapped in `ENC(...)` (including URL-encoded `ENC%28...%29`).
 */
export function decryptConnectionUrl(
  rawUrl: string | null | undefined,
  masterPassword?: string
): string {
  if (!rawUrl) return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  if (isEncryptedValue(trimmed)) {
    return decryptSecret(trimmed, masterPassword);
  }

  // Handle `scheme://user:ENC(...)@host:port/db`
  const match = trimmed.match(/^([a-z0-9+.-]+:\/\/[^:@/]+:)(.+?)(@.+)$/i);
  if (match) {
    const [, prefix, rawPwd, suffix] = match;
    let decodedPwd = rawPwd;
    try {
      decodedPwd = decodeURIComponent(rawPwd);
    } catch {
      // keep raw
    }
    if (isEncryptedValue(decodedPwd)) {
      const plainPwd = decryptSecret(decodedPwd, masterPassword);
      return `${prefix}${encodeURIComponent(plainPwd)}${suffix}`;
    }
  }

  return trimmed;
}

/**
 * Encrypt all string values in a key-value map (e.g. MCP headers / DB secrets)
 * so no sensitive tokens are stored in plaintext in SQLite / PG / MySQL / GaussDB.
 */
export function encryptRecordValues(
  record: Record<string, string>,
  masterPassword?: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = v ? encryptSecret(v, masterPassword) : "";
  }
  return out;
}

/**
 * Decrypt all `ENC(...)` string values in a key-value map read from the database.
 */
export function decryptRecordValues(
  record: Record<string, string>,
  masterPassword?: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!v) {
      out[k] = "";
      continue;
    }
    try {
      out[k] = decryptIfEncrypted(v, masterPassword);
    } catch {
      // Preserve raw value if master key changed or legacy plaintext
      out[k] = v;
    }
  }
  return out;
}
