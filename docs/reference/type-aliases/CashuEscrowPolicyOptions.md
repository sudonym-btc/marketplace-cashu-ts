# Type Alias: CashuEscrowPolicyOptions

> **CashuEscrowPolicyOptions** = `MarketplaceDriverConstructorOptions` & `object`

## Type Declaration

### mints

> **mints**: [`CashuMintConfig`](CashuMintConfig.md)[]

### now?

> `optional` **now?**: () => `number`

#### Returns

`number`

### quoteClaimLeaseMs?

> `optional` **quoteClaimLeaseMs?**: `number`

Duration of the pre-request quote-creation ownership lease.

### quoteClaimPollIntervalMs?

> `optional` **quoteClaimPollIntervalMs?**: `number`

Storage polling interval while another caller owns quote creation.

### quoteClaimWaitTimeoutMs?

> `optional` **quoteClaimWaitTimeoutMs?**: `number`

Maximum time a concurrent caller waits for the quote owner to publish its result.

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
