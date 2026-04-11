/**
 * Unit tests for URL validator — SSRF protection.
 * Blocks private IPs, non-HTTP protocols, and metadata endpoints.
 */

import { describe, it, expect } from "vitest";

describe("URL Validator — SSRF Protection", () => {
  describe("validateDestinationUrl — protocol validation", () => {
    it("should accept https:// URLs", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("https://example.com/hook")).not.toThrow();
    });

    it("should accept http:// URLs", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://example.com/hook")).not.toThrow();
    });

    it("should reject ftp:// protocol", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("ftp://example.com/file")).toThrow();
    });

    it("should reject file:// protocol", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("file:///etc/passwd")).toThrow();
    });

    it("should reject javascript: protocol", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("javascript:alert(1)")).toThrow();
    });

    it("should reject data: protocol", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("data:text/plain,hello")).toThrow();
    });

    it("should reject empty URL", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("")).toThrow();
    });

    it("should reject malformed URL", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("not-a-url")).toThrow();
    });
  });

  describe("validateDestinationUrl — private IP blocking", () => {
    it("should reject localhost (127.0.0.1)", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://127.0.0.1/hook")).toThrow();
    });

    it("should reject 127.x.x.x range", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://127.0.0.2:8080/hook")).toThrow();
    });

    it("should reject 10.x.x.x private range", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://10.0.0.1/hook")).toThrow();
    });

    it("should reject 172.16.x.x private range", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://172.16.0.1/hook")).toThrow();
    });

    it("should reject 172.31.x.x (end of 172.16/12 range)", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://172.31.255.255/hook")).toThrow();
    });

    it("should accept 172.32.x.x (outside private range)", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://172.32.0.1/hook")).not.toThrow();
    });

    it("should reject 192.168.x.x private range", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://192.168.1.1/hook")).toThrow();
    });

    it("should reject 169.254.x.x link-local / metadata IP", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://169.254.169.254/latest/meta-data")).toThrow();
    });

    it("should reject 0.0.0.0", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://0.0.0.0/hook")).toThrow();
    });

    it("should reject localhost hostname", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://localhost/hook")).toThrow();
    });

    it("should reject localhost with port", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://localhost:3000/hook")).toThrow();
    });
  });

  describe("validateDestinationUrl — IPv6 blocking", () => {
    it("should reject ::1 (IPv6 loopback)", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://[::1]/hook")).toThrow();
    });

    it("should reject fc00::/7 (unique local)", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://[fc00::1]/hook")).toThrow();
    });

    it("should reject fd00::/8 (unique local)", async () => {
      const { validateDestinationUrl } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(() => validateDestinationUrl("http://[fd00::1]/hook")).toThrow();
    });
  });

  describe("isPrivateIp — direct IP checks", () => {
    it("should return true for 127.0.0.1", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("127.0.0.1")).toBe(true);
    });

    it("should return true for 10.0.0.1", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("10.0.0.1")).toBe(true);
    });

    it("should return true for 172.16.0.1", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("172.16.0.1")).toBe(true);
    });

    it("should return true for 192.168.0.1", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("192.168.0.1")).toBe(true);
    });

    it("should return true for 169.254.169.254", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("169.254.169.254")).toBe(true);
    });

    it("should return true for 0.0.0.0", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("0.0.0.0")).toBe(true);
    });

    it("should return true for ::1", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("::1")).toBe(true);
    });

    it("should return true for fc00::1", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("fc00::1")).toBe(true);
    });

    it("should return false for 8.8.8.8 (public)", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("8.8.8.8")).toBe(false);
    });

    it("should return false for 93.184.216.34 (example.com)", async () => {
      const { isPrivateIp } = await import(
        "../../../src/lib/url-validator.js"
      );
      expect(isPrivateIp("93.184.216.34")).toBe(false);
    });
  });

  describe("UnsafeUrlError", () => {
    it("should be an instance of AppError with status 400", async () => {
      const { UnsafeUrlError } = await import(
        "../../../src/lib/url-validator.js"
      );
      const { AppError } = await import("../../../src/lib/errors.js");

      const error = new UnsafeUrlError("test message");
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("UNSAFE_URL");
    });
  });
});
