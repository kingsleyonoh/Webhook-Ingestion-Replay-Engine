/**
 * Unit tests for AES-256-GCM encryption/decryption utility.
 * Tests:
 * - encrypt→decrypt roundtrip produces original plaintext
 * - encrypted output is base64 and differs from plaintext
 * - decrypt with wrong key fails
 * - decrypt with tampered ciphertext fails
 * - getEncryptionKey reads SIGNING_SECRET_KEY env var
 * - getEncryptionKey throws clear error when env var missing
 * - getEncryptionKey throws when key is wrong length
 * - encrypt handles empty string
 * - encrypt handles unicode
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("crypto — AES-256-GCM encrypt/decrypt (unit)", () => {
  // 32 bytes = 64 hex chars
  const validKeyHex =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const validKey = Buffer.from(validKeyHex, "hex");

  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["SIGNING_SECRET_KEY"];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["SIGNING_SECRET_KEY"] = originalEnv;
    } else {
      delete process.env["SIGNING_SECRET_KEY"];
    }
  });

  it("should encrypt and decrypt roundtrip to original plaintext", async () => {
    const { encrypt, decrypt } = await import(
      "../../../src/lib/crypto.js"
    );
    const plaintext = "whsec_my_super_secret_signing_key";
    const encrypted = encrypt(plaintext, validKey);
    const decrypted = decrypt(encrypted, validKey);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce base64 output different from plaintext", async () => {
    const { encrypt } = await import("../../../src/lib/crypto.js");
    const plaintext = "whsec_test_secret";
    const encrypted = encrypt(plaintext, validKey);
    expect(encrypted).not.toBe(plaintext);
    // Should be valid base64
    expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
  });

  it("should fail to decrypt with wrong key", async () => {
    const { encrypt, decrypt } = await import(
      "../../../src/lib/crypto.js"
    );
    const plaintext = "whsec_secret_value";
    const encrypted = encrypt(plaintext, validKey);

    const wrongKeyHex =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const wrongKey = Buffer.from(wrongKeyHex, "hex");

    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("should fail to decrypt tampered ciphertext", async () => {
    const { encrypt, decrypt } = await import(
      "../../../src/lib/crypto.js"
    );
    const plaintext = "whsec_secret_value";
    const encrypted = encrypt(plaintext, validKey);

    // Tamper with the ciphertext
    const tampered =
      encrypted.slice(0, -4) +
      (encrypted.slice(-4) === "AAAA" ? "BBBB" : "AAAA");

    expect(() => decrypt(tampered, validKey)).toThrow();
  });

  it("should encrypt and decrypt empty string", async () => {
    const { encrypt, decrypt } = await import(
      "../../../src/lib/crypto.js"
    );
    const encrypted = encrypt("", validKey);
    const decrypted = decrypt(encrypted, validKey);
    expect(decrypted).toBe("");
  });

  it("should encrypt and decrypt unicode content", async () => {
    const { encrypt, decrypt } = await import(
      "../../../src/lib/crypto.js"
    );
    const plaintext = "secret-with-unicod\u00e9-\u00e4\u00f6\u00fc-\u2603";
    const encrypted = encrypt(plaintext, validKey);
    const decrypted = decrypt(encrypted, validKey);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce different ciphertexts for same plaintext (random IV)", async () => {
    const { encrypt } = await import("../../../src/lib/crypto.js");
    const plaintext = "whsec_same_input";
    const encrypted1 = encrypt(plaintext, validKey);
    const encrypted2 = encrypt(plaintext, validKey);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it("getEncryptionKey should read SIGNING_SECRET_KEY from env", async () => {
    process.env["SIGNING_SECRET_KEY"] = validKeyHex;
    const { getEncryptionKey } = await import(
      "../../../src/lib/crypto.js"
    );
    const key = getEncryptionKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("getEncryptionKey should throw when SIGNING_SECRET_KEY is missing", async () => {
    delete process.env["SIGNING_SECRET_KEY"];
    const { getEncryptionKey } = await import(
      "../../../src/lib/crypto.js"
    );
    expect(() => getEncryptionKey()).toThrow("SIGNING_SECRET_KEY");
  });

  it("getEncryptionKey should throw when key is wrong length", async () => {
    process.env["SIGNING_SECRET_KEY"] = "0123456789abcdef"; // only 16 hex chars
    const { getEncryptionKey } = await import(
      "../../../src/lib/crypto.js"
    );
    expect(() => getEncryptionKey()).toThrow();
  });
});
