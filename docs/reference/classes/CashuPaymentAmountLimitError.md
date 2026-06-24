# Class: CashuPaymentAmountLimitError

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:236](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L236)

## Extends

- `Error`

## Constructors

### Constructor

> **new CashuPaymentAmountLimitError**(`reason`, `limits`): `CashuPaymentAmountLimitError`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:240](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L240)

#### Parameters

##### reason

`LimitReason`

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

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:238](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L238)

***

### limits

> `readonly` **limits**: [`CashuPaymentAmountLimits`](../type-aliases/CashuPaymentAmountLimits.md)

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:242](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L242)

***

### message

> **message**: `string`

Defined in: node\_modules/typescript/lib/lib.es5.d.ts:1075

#### Inherited from

`Error.message`

***

### name

> `readonly` **name**: `"CashuPaymentAmountLimitError"` = `'CashuPaymentAmountLimitError'`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:237](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L237)

#### Overrides

`Error.name`

***

### reason

> `readonly` **reason**: `LimitReason`

Defined in: [dependencies/marketplace-cashu-ts/src/marketplace/escrowPolicy.ts:241](https://github.com/sudonym-btc/marketplace-cashu-ts/blob/b14c7839d5f2ffcd86a450c02af342328274d02a/src/marketplace/escrowPolicy.ts#L241)

***

### stack?

> `optional` **stack?**: `string`

Defined in: node\_modules/typescript/lib/lib.es5.d.ts:1076

#### Inherited from

`Error.stack`
