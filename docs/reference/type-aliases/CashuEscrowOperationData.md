# Type Alias: CashuEscrowOperationData

> **CashuEscrowOperationData** = `object`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:17](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L17)

Public, allowlisted recovery metadata for a Cashu mint operation.

Bearer proofs, seeds, private keys, prepared outputs, and other secret
material MUST NOT be stored in this record. Mint outputs are derived again
from the caller-provided marketplace seed and request fingerprint.

## Properties

### arbiterCashuPubkey

> **arbiterCashuPubkey**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:26](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L26)

***

### buyerCashuPubkey

> **buyerCashuPubkey**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:24](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L24)

***

### conditionHash

> **conditionHash**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:23](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L23)

***

### decimals

> **decimals**: `number`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:32](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L32)

***

### denomination

> **denomination**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:31](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L31)

***

### description

> **description**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:33](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L33)

***

### escrowFee

> **escrowFee**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:30](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L30)

***

### fundingAmount

> **fundingAmount**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:28](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L28)

***

### locktime

> **locktime**: `number`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:27](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L27)

***

### mintKeysetId?

> `optional` **mintKeysetId?**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:35](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L35)

***

### outputDerivationVersion

> **outputDerivationVersion**: `1`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:20](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L20)

***

### paymentAmount

> **paymentAmount**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:29](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L29)

***

### policyHash

> **policyHash**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:22](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L22)

***

### policyType

> **policyType**: `"cashu:p2pk-escrow-v1"` \| `"cashu:p2pk-auction-v1"`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:21](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L21)

***

### quoteExpiry?

> `optional` **quoteExpiry?**: `number` \| `null`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:34](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L34)

***

### recycleFeeReserve?

> `optional` **recycleFeeReserve?**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:36](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L36)

***

### requestFingerprint

> **requestFingerprint**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:19](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L19)

***

### sellerCashuPubkey

> **sellerCashuPubkey**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:25](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L25)

***

### version

> **version**: `1`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:18](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L18)
