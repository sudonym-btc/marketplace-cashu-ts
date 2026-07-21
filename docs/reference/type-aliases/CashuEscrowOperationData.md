# Type Alias: CashuEscrowOperationData

> **CashuEscrowOperationData** = `object`

Public, allowlisted recovery metadata for a Cashu mint operation.

Bearer proofs, seeds, private keys, prepared outputs, and other secret
material MUST NOT be stored in this record. Mint outputs are derived again
from the caller-provided marketplace seed and request fingerprint.

## Properties

### arbiterCashuPubkey

> **arbiterCashuPubkey**: `string`

***

### buyerCashuPubkey

> **buyerCashuPubkey**: `string`

***

### conditionHash

> **conditionHash**: `string`

***

### decimals

> **decimals**: `number`

***

### denomination

> **denomination**: `string`

***

### description

> **description**: `string`

***

### escrowFee

> **escrowFee**: `string`

***

### fundingAmount

> **fundingAmount**: `string`

***

### locktime

> **locktime**: `number`

***

### mintKeysetId?

> `optional` **mintKeysetId?**: `string`

***

### outputDerivationVersion

> **outputDerivationVersion**: `1`

***

### paymentAmount

> **paymentAmount**: `string`

***

### policyHash

> **policyHash**: `string`

***

### policyType

> **policyType**: `"cashu:p2pk-escrow-v1"` \| `"cashu:p2pk-auction-v1"`

***

### quoteExpiry?

> `optional` **quoteExpiry?**: `number` \| `null`

***

### recycleFeeReserve?

> `optional` **recycleFeeReserve?**: `string`

***

### requestFingerprint

> **requestFingerprint**: `string`

***

### sellerCashuPubkey

> **sellerCashuPubkey**: `string`

***

### version

> **version**: `1`
