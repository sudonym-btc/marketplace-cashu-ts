# Type Alias: CashuRefundArgs

> **CashuRefundArgs** = `object`

## Properties

### message

> **message**: `string`

***

### messageHash

> **messageHash**: `string`

***

### refundPercent

> **refundPercent**: `100`

***

### signature

> **signature**: `string`

***

### signerPubkey

> **signerPubkey**: `string`

***

### source

> **source**: `object`

#### inputFee

> **inputFee**: `string`

#### keysetActiveUntil

> **keysetActiveUntil**: `number`

#### keysetId

> **keysetId**: `string`

#### mint

> **mint**: `string`

#### policyType

> **policyType**: *typeof* [`cashuAuctionPolicyType`](../variables/cashuAuctionPolicyType.md)

#### settlementId

> **settlementId**: `string`

#### sourceValue

> **sourceValue**: `string`

#### tradeId

> **tradeId**: `string`

#### unit

> **unit**: `string`

***

### swap

> **swap**: [`CashuSerializedSwapPreview`](CashuSerializedSwapPreview.md)

***

### target

> **target**: `object`

#### buyerOutputValue

> **buyerOutputValue**: `string`

#### buyerPubkey

> **buyerPubkey**: `string`

#### policyType

> **policyType**: *typeof* [`cashuRefundPolicyType`](../variables/cashuRefundPolicyType.md)

***

### type

> **type**: `"cashu:p2pk-auction-refund-v1"`

***

### version

> **version**: `1`
