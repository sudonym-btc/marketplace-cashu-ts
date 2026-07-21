# Class: CashuPaymentAmountLimitError

## Extends

- `Error`

## Constructors

### Constructor

> **new CashuPaymentAmountLimitError**(`reason`, `limits`): `CashuPaymentAmountLimitError`

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

#### Inherited from

`Error.cause`

***

### code

> `readonly` **code**: `"PAYMENT_AMOUNT_LIMIT"` = `'PAYMENT_AMOUNT_LIMIT'`

***

### limits

> `readonly` **limits**: [`CashuPaymentAmountLimits`](../type-aliases/CashuPaymentAmountLimits.md)

***

### message

> **message**: `string`

#### Inherited from

`Error.message`

***

### name

> `readonly` **name**: `"CashuPaymentAmountLimitError"` = `'CashuPaymentAmountLimitError'`

#### Overrides

`Error.name`

***

### reason

> `readonly` **reason**: [`CashuPaymentAmountLimitReason`](../type-aliases/CashuPaymentAmountLimitReason.md)

***

### stack?

> `optional` **stack?**: `string`

#### Inherited from

`Error.stack`
