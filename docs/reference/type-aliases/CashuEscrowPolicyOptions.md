# Type Alias: CashuEscrowPolicyOptions

> **CashuEscrowPolicyOptions** = `MarketplaceDriverConstructorOptions` & `object`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:78](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/marketplace/escrowPolicy.ts#L78)

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
