# Type Alias: CashuEscrowPolicyOptions

> **CashuEscrowPolicyOptions** = `MarketplaceDriverConstructorOptions` & `object`

## Type Declaration

### mints

> **mints**: [`CashuMintConfig`](CashuMintConfig.md)[]

### now?

> `optional` **now?**: () => `number`

#### Returns

`number`

### quotePaymentTimeoutMs?

> `optional` **quotePaymentTimeoutMs?**: `number`

### quotePollIntervalMs?

> `optional` **quotePollIntervalMs?**: `number`

### storage

> **storage**: [`CashuEscrowStorage`](CashuEscrowStorage.md)

### walletFactory?

> `optional` **walletFactory?**: (`mint`) => `Wallet`

#### Parameters

##### mint

[`CashuMintConfig`](CashuMintConfig.md)

#### Returns

`Wallet`
