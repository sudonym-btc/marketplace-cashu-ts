# Type Alias: CashuEscrowPolicyOptions

> **CashuEscrowPolicyOptions** = `object`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:68](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L68)

## Properties

### appId?

> `optional` **appId?**: `string`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:71](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L71)

***

### logger?

> `optional` **logger?**: `MarketplaceDriverLogger`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:76](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L76)

***

### mints

> **mints**: [`CashuMintConfig`](CashuMintConfig.md)[]

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:69](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L69)

***

### now?

> `optional` **now?**: () => `number`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:75](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L75)

#### Returns

`number`

***

### quotePaymentTimeoutMs?

> `optional` **quotePaymentTimeoutMs?**: `number`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:73](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L73)

***

### quotePollIntervalMs?

> `optional` **quotePollIntervalMs?**: `number`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:72](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L72)

***

### storage

> **storage**: [`CashuEscrowStorage`](CashuEscrowStorage.md)

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:70](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L70)

***

### walletFactory?

> `optional` **walletFactory?**: (`mint`) => `Wallet`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:74](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L74)

#### Parameters

##### mint

[`CashuMintConfig`](CashuMintConfig.md)

#### Returns

`Wallet`
