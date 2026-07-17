# Class: CashuPaymentAmountLimitError

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:248](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/marketplace/escrowPolicy.ts#L248)

## Extends

- `Error`

## Constructors

### Constructor

> **new CashuPaymentAmountLimitError**(`reason`, `limits`): `CashuPaymentAmountLimitError`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:252](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/marketplace/escrowPolicy.ts#L252)

#### Parameters

##### reason

[`CashuPaymentAmountLimitReason`](../type-aliases/CashuPaymentAmountLimitReason.md)

##### limits

[`CashuPaymentAmountLimits`](../type-aliases/CashuPaymentAmountLimits.md)

#### Returns

`CashuPaymentAmountLimitError`

#### Overrides

`Error.constructor`

## Properties

### cause?

> `optional` **cause?**: `unknown`

Defined in: node\_modules/typescript/lib/lib.es2022.error.d.ts:24

#### Inherited from

`Error.cause`

***

### code

> `readonly` **code**: `"PAYMENT_AMOUNT_LIMIT"` = `'PAYMENT_AMOUNT_LIMIT'`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:250](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/marketplace/escrowPolicy.ts#L250)

***

### limits

> `readonly` **limits**: [`CashuPaymentAmountLimits`](../type-aliases/CashuPaymentAmountLimits.md)

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:254](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/marketplace/escrowPolicy.ts#L254)

***

### message

> **message**: `string`

Defined in: node\_modules/typescript/lib/lib.es5.d.ts:1075

#### Inherited from

`Error.message`

***

### name

> `readonly` **name**: `"CashuPaymentAmountLimitError"` = `'CashuPaymentAmountLimitError'`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:249](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/marketplace/escrowPolicy.ts#L249)

#### Overrides

`Error.name`

***

### reason

> `readonly` **reason**: [`CashuPaymentAmountLimitReason`](../type-aliases/CashuPaymentAmountLimitReason.md)

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:253](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/02257a545e817cfc7aa13870cd0779c21dd89987/src/marketplace/escrowPolicy.ts#L253)

***

### stack?

> `optional` **stack?**: `string`

Defined in: node\_modules/typescript/lib/lib.es5.d.ts:1076

#### Inherited from

`Error.stack`
