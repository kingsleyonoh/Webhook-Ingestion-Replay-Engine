# Webhook Test Fixtures

Sample webhook payloads for integration and unit tests.

## Test Signing Secrets

These secrets and keys are used exclusively in tests to generate and verify webhook signatures.

| Source   | Algorithm    | Signing Secret              | Signature Header         |
|----------|--------------|-----------------------------|--------------------------|
| Stripe   | hmac-sha256  | `whsec_test_stripe_secret`  | `Stripe-Signature`       |
| GitHub   | hmac-sha256  | `ghsec_test_github_secret`  | `X-Hub-Signature-256`    |
| Shopify  | hmac-sha256  | `shpsec_test_shopify_secret`| `X-Shopify-Hmac-Sha256`  |
| Wise     | rsa-sha256   | generated RSA test key      | `X-Signature-SHA256`     |

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

Signatures are computed at test time using the test signing secrets or generated keys above and the raw payload bytes.
