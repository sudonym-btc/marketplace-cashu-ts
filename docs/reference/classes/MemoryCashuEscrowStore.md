# Class: MemoryCashuEscrowStore

## Implements

- [`CashuEscrowStorage`](../type-aliases/CashuEscrowStorage.md)

## Constructors

### Constructor

> **new MemoryCashuEscrowStore**(): `MemoryCashuEscrowStore`

#### Returns

`MemoryCashuEscrowStore`

## Methods

### compareAndSet()

> **compareAndSet**(`id`, `expectedRevision`, `replacement`): `Promise`\<`boolean`\>

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

[`CashuEscrowOperation`](../type-aliases/CashuEscrowOperation.md)

#### Returns

`Promise`\<`boolean`\>

#### Implementation of

`CashuEscrowStorage.compareAndSet`

***

### create()

> **create**(`record`): `Promise`\<`boolean`\>

Atomically insert a new operation, returning false when the id exists.

#### Parameters

##### record

[`CashuEscrowOperation`](../type-aliases/CashuEscrowOperation.md)

#### Returns

`Promise`\<`boolean`\>

#### Implementation of

`CashuEscrowStorage.create`

***

### delete()

> **delete**(`id`): `Promise`\<`void`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`void`\>

#### Implementation of

`CashuEscrowStorage.delete`

***

### get()

> **get**(`id`): `Promise`\<[`CashuEscrowOperation`](../type-aliases/CashuEscrowOperation.md) \| `null`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`CashuEscrowOperation`](../type-aliases/CashuEscrowOperation.md) \| `null`\>

#### Implementation of

`CashuEscrowStorage.get`

***

### list()

> **list**(`query?`): `Promise`\<[`CashuEscrowOperation`](../type-aliases/CashuEscrowOperation.md)[]\>

#### Parameters

##### query?

[`CashuEscrowOperationQuery`](../type-aliases/CashuEscrowOperationQuery.md) = `{}`

#### Returns

`Promise`\<[`CashuEscrowOperation`](../type-aliases/CashuEscrowOperation.md)[]\>

#### Implementation of

`CashuEscrowStorage.list`

***

### put()

> **put**(`record`): `Promise`\<`void`\>

#### Parameters

##### record

[`CashuEscrowOperation`](../type-aliases/CashuEscrowOperation.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

`CashuEscrowStorage.put`
