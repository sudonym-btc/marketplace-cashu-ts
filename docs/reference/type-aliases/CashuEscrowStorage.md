# Type Alias: CashuEscrowStorage

> **CashuEscrowStorage** = `object`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:64](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L64)

## Methods

### create()?

> `optional` **create**(`record`): `Promise`\<`boolean`\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:67](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L67)

Atomically insert a new operation, returning false when the id exists.

#### Parameters

##### record

[`CashuEscrowOperation`](CashuEscrowOperation.md)

#### Returns

`Promise`\<`boolean`\>

***

### delete()

> **delete**(`id`): `Promise`\<`void`\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:70](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L70)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`id`): `Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md) \| `null`\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:65](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L65)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md) \| `null`\>

***

### list()

> **list**(`query?`): `Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md)[]\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:69](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L69)

#### Parameters

##### query?

[`CashuEscrowOperationQuery`](CashuEscrowOperationQuery.md)

#### Returns

`Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md)[]\>

***

### put()

> **put**(`record`): `Promise`\<`void`\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:68](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/storage.ts#L68)

#### Parameters

##### record

[`CashuEscrowOperation`](CashuEscrowOperation.md)

#### Returns

`Promise`\<`void`\>
