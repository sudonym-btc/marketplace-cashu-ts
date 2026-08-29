# Type Alias: CashuEscrowOperationClaim

> **CashuEscrowOperationClaim** = `object`

Short-lived ownership metadata for the one non-idempotent mint-quote call.

A `reserved` claim may be replaced after expiry because the durable status
still proves that no request has started. A `requesting` claim is the
irreversible point of no return and must never be stolen or retried.

## Properties

### expiresAt

> **expiresAt**: `number`

Unix epoch milliseconds.

***

### owner

> **owner**: `string`

***

### phase

> **phase**: `"reserved"` \| `"requesting"`

***

### purpose

> **purpose**: `"mint_quote"`

***

### version

> **version**: `1`
