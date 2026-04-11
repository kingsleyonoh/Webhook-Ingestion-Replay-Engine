/**
 * AES-256-GCM encryption/decryption for signing secrets at rest.
 * Used to encrypt source signing_secret before DB persistence
 * and decrypt before signature verification.
 *
 * Format: base64(iv[12] + authTag[16] + ciphertext)
 * Key: SIGNING_SECRET_KEY env var — 64 hex chars (32 bytes)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns base64(iv + authTag + ciphertext).
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext (variable)
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Expects format: base64(iv[12] + authTag[16] + ciphertext).
 */
export function decrypt(encoded: string, key: Buffer): string {
  const packed = Buffer.from(encoded, "base64");

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Read and validate the encryption key from environment.
 * SIGNING_SECRET_KEY must be 64 hex characters (32 bytes).
 */
export function getEncryptionKey(): Buffer {
  const keyHex = process.env["SIGNING_SECRET_KEY"];

  if (!keyHex) {
    throw new Error(
      "SIGNING_SECRET_KEY environment variable is required for signing secret encryption"
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      "SIGNING_SECRET_KEY must be exactly 64 hex characters (32 bytes)"
    );
  }

  return Buffer.from(keyHex, "hex");
}
