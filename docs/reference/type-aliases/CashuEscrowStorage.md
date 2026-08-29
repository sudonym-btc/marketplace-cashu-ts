# Type Alias: CashuEscrowStorage

> **CashuEscrowStorage** = `object`

## Methods

### compareAndSet()?

> `optional` **compareAndSet**(`id`, `expectedRevision`, `replacement`): `Promise`\<`boolean`\>

Atomically replace an operation only when its current revision equals
`expectedRevision`. The replacement revision must be
`expectedRevision + 1`.

Durable stores shared by more than one policy instance or process MUST
implement this primitive. It lets a caller take a pre-request lease while
ensuring only one caller can cross the quote-request point of no return.

#### Parameters

##### id

`string`

##### expectedRevision

`number`

##### replacement

[`CashuEscrowOperation`](CashuEscrowOperation.md)

#### Returns

`Promise`\<`boolean`\>

***

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
