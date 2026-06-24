# Type Alias: CashuEscrowStorage

> **CashuEscrowStorage** = `object`

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:35](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/storage.ts#L35)

## Methods

### delete()

> **delete**(`id`): `Promise`\<`void`\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:39](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/storage.ts#L39)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`id`): `Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md) \| `null`\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:36](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/storage.ts#L36)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md) \| `null`\>

***

### list()

> **list**(`query?`): `Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md)[]\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:38](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/storage.ts#L38)

#### Parameters

##### query?

[`CashuEscrowOperationQuery`](CashuEscrowOperationQuery.md)

#### Returns

`Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md)[]\>

***

### put()

> **put**(`record`): `Promise`\<`void`\>

Defined in: [dependencies/marketplace-cashu-ts/src/storage.ts:37](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/storage.ts#L37)

#### Parameters

##### record

[`CashuEscrowOperation`](CashuEscrowOperation.md)

#### Returns

`Promise`\<`void`\>
