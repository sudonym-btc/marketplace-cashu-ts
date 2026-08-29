# Type Alias: CashuEscrowOperation

> **CashuEscrowOperation** = `object`

## Properties

### accountIndex

> **accountIndex**: `number`

***

### claim?

> `optional` **claim?**: [`CashuEscrowOperationClaim`](CashuEscrowOperationClaim.md)

***

### createdAt

> **createdAt**: `number`

***

### data

> **data**: [`CashuEscrowOperationData`](CashuEscrowOperationData.md)

***

### error?

> `optional` **error?**: `string`

***

### id

> **id**: `string`

***

### kind

> **kind**: `"cashu_escrow_mint"` \| `"cashu_auction_mint"`

***

### mintUrl

> **mintUrl**: `string`

***

### quoteId?

> `optional` **quoteId?**: `string`

***

### request?

> `optional` **request?**: `string`

***

### revision?

> `optional` **revision?**: `number`

Monotonic revision used by compareAndSet(). Legacy records imply zero.

***

### settlementId

> **settlementId**: `string`

***

### status

> **status**: [`CashuEscrowOperationStatus`](CashuEscrowOperationStatus.md)

***

### tradeId

> **tradeId**: `string`

***

### unit

> **unit**: `string`

***

### updatedAt

> **updatedAt**: `number`
