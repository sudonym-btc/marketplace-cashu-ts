# Type Alias: CashuRecycleArgs

> **CashuRecycleArgs** = `object`

## Properties

### fromPolicyType

> **fromPolicyType**: *typeof* [`cashuAuctionPolicyType`](../variables/cashuAuctionPolicyType.md)

***

### message

> **message**: `string`

***

### messageHash

> **messageHash**: `string`

***

### signature

> **signature**: `string`

***

### signerPubkey

> **signerPubkey**: `string`

***

### source

> **source**: `object`

#### policyType

> **policyType**: *typeof* [`cashuAuctionPolicyType`](../variables/cashuAuctionPolicyType.md)

#### settlementId

> **settlementId**: `string`

#### tradeId

> **tradeId**: `string`

***

### swap?

> `optional` **swap?**: [`CashuSerializedSwapPreview`](CashuSerializedSwapPreview.md)

***

### target

> **target**: `object`

#### conditionHash

> **conditionHash**: `string`

#### locktime

> **locktime**: `number`

#### order?

> `optional` **order?**: `Record`\<`string`, `unknown`\>

#### p2pkOptions

> **p2pkOptions**: `ReturnType`\<*typeof* [`cashuEscrowP2pkOptions`](../functions/cashuEscrowP2pkOptions.md)\>

#### participants

> **participants**: [`CashuEscrowParticipants`](CashuEscrowParticipants.md)

#### policyHash

> **policyHash**: `string`

#### policyType

> **policyType**: *typeof* [`cashuEscrowPolicyType`](../variables/cashuEscrowPolicyType.md)

#### settlementId

> **settlementId**: `string`

#### tradeId

> **tradeId**: `string`

***

### toPolicyType

> **toPolicyType**: *typeof* [`cashuEscrowPolicyType`](../variables/cashuEscrowPolicyType.md)

***

### type

> **type**: `"cashu:p2pk-auction-promote-v1"`

***

### version

> **version**: `1`
