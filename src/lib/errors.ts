/**
 * Centralized error classes for the Webhook Ingestion Engine.
 * All errors follow the Section 8b response format:
 * { error: { code, message, details } }
 */

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: string[];

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details: string[] = []
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    // Ensure prototype chain works correctly with ES5+ transpilation
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): { error: { code: string; message: string; details: string[] } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export class SourceNotFoundError extends AppError {
  constructor(slug: string) {
    super(
      "SOURCE_NOT_FOUND",
      `No webhook source found with slug '${slug}'`,
      404
    );
    this.name = "SourceNotFoundError";
  }
}

export class SignatureInvalidError extends AppError {
  constructor(message = "Webhook signature verification failed") {
    super("SIGNATURE_INVALID", message, 401);
    this.name = "SignatureInvalidError";
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(actual: number, limit: number) {
    super(
      "PAYLOAD_TOO_LARGE",
      `Payload size ${actual} bytes exceeds limit of ${limit} bytes`,
      413
    );
    this.name = "PayloadTooLargeError";
  }
}

export class RateLimitExceededError extends AppError {
  constructor(message = "Rate limit exceeded, please retry later") {
    super("RATE_LIMIT_EXCEEDED", message, 429);
    this.name = "RateLimitExceededError";
  }
}

export class DuplicateEventError extends AppError {
  constructor(idempotencyKey: string) {
    super(
      "DUPLICATE_EVENT",
      `Event with idempotency key '${idempotencyKey}' already processed`,
      200
    );
    this.name = "DuplicateEventError";
  }
}

export class TenantNotFoundError extends AppError {
  constructor(message = "No tenant found for the provided API key") {
    super("TENANT_NOT_FOUND", message, 401);
    this.name = "TenantNotFoundError";
  }
}

export class TenantInactiveError extends AppError {
  constructor(message = "Tenant account is inactive") {
    super("TENANT_INACTIVE", message, 403);
    this.name = "TenantInactiveError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: string[] = []) {
    super("VALIDATION_ERROR", message, 400, details);
    this.name = "ValidationError";
  }
}

export class QueueOverloadError extends AppError {
  constructor(currentDepth: number, maxDepth: number) {
    super(
      "QUEUE_OVERLOAD",
      `Queue depth ${currentDepth} exceeds maximum ${maxDepth}`,
      429
    );
    this.name = "QueueOverloadError";
  }
}
