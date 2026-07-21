# Type Alias: CashuEscrowStorage

> **CashuEscrowStorage** = `object`

## Methods

### create()?

> `optional` **create**(`record`): `Promise`\<`boolean`\>

Atomically insert a new operation, returning false when the id exists.

#### Parameters

##### record

[`CashuEscrowOperation`](CashuEscrowOperation.md)

#### Returns

`Promise`\<`boolean`\>

***

### delete()

> **delete**(`id`): `Promise`\<`void`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`id`): `Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md) \| `null`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md) \| `null`\>

***

### list()

> **list**(`query?`): `Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md)[]\>

#### Parameters

##### query?

[`CashuEscrowOperationQuery`](CashuEscrowOperationQuery.md)

#### Returns

`Promise`\<[`CashuEscrowOperation`](CashuEscrowOperation.md)[]\>

***

### put()

> **put**(`record`): `Promise`\<`void`\>

#### Parameters

##### record

[`CashuEscrowOperation`](CashuEscrowOperation.md)

#### Returns

`Promise`\<`void`\>
