# Webhook Test Fixtures

Sample webhook payloads for integration and unit tests.

## Test Signing Secrets

These secrets are used exclusively in tests to generate and verify HMAC signatures.

| Source   | Algorithm    | Signing Secret              | Signature Header         |
|----------|--------------|-----------------------------|--------------------------|
| Stripe   | hmac-sha256  | `whsec_test_stripe_secret`  | `Stripe-Signature`       |
| GitHub   | hmac-sha256  | `ghsec_test_github_secret`  | `X-Hub-Signature-256`    |
| Shopify  | hmac-sha256  | `shpsec_test_shopify_secret`| `X-Shopify-Hmac-Sha256`  |

## Fixture Files

| Directory  | File                              | Event Type                    |
|------------|-----------------------------------|-------------------------------|
| `stripe/`  | `checkout.session.completed.json` | Stripe checkout completed     |
| `github/`  | `push.json`                       | GitHub push event             |
| `shopify/` | `orders-create.json`              | Shopify order creation        |

## Usage in Tests

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const payload = readFileSync(
  resolve(import.meta.dirname, "../fixtures/stripe/checkout.session.completed.json"),
  "utf-8"
);
```

Signatures are computed at test time using the test signing secrets above and the raw payload bytes.
