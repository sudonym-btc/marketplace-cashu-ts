# Type Alias: CashuEscrowPolicy

> **CashuEscrowPolicy** = `MarketplaceDriverOrderPolicy`\<[`GenericPolicyPaymentState`](GenericPolicyPaymentState.md), [`CashuEscrowPaymentPolicy`](CashuEscrowPaymentPolicy.md), [`CashuPaymentAsset`](CashuPaymentAsset.md), [`GenericPaymentIntent`](GenericPaymentIntent.md), [`GenericPaymentValidationRequest`](GenericPaymentValidationRequest.md), [`GenericPaymentValidationResult`](GenericPaymentValidationResult.md), [`GenericPaymentSweepInput`](GenericPaymentSweepInput.md), [`GenericPaymentSweepState`](GenericPaymentSweepState.md), [`GenericPaymentSettlementIntent`](GenericPaymentSettlementIntent.md), [`GenericPaymentSettlementState`](GenericPaymentSettlementState.md), [`GenericSwapResumeContext`](GenericSwapResumeContext.md), [`GenericSwapResumeState`](GenericSwapResumeState.md)\> & `object`

## Type Declaration

### id

> **id**: `"cashu:p2pk-escrow-v1"`

### method

> **method**: `"cashu"`

### assets()

> **assets**(): [`CashuPaymentAsset`](CashuPaymentAsset.md)[]

#### Returns

[`CashuPaymentAsset`](CashuPaymentAsset.md)[]

### discoverHighWatermark()

> **discoverHighWatermark**(`context`): `Promise`\<`MarketplaceDriverWatermarkDiscovery` & `object`\>

#### Parameters

##### context

`MarketplaceDriverWatermarkContext`

#### Returns

`Promise`\<`MarketplaceDriverWatermarkDiscovery` & `object`\>

### pay()

> **pay**(`intent`): `AsyncIterable`\<[`GenericPolicyPaymentState`](GenericPolicyPaymentState.md)\>

#### Parameters

##### intent

`MarketplaceDriverPaymentIntent`

#### Returns

`AsyncIterable`\<[`GenericPolicyPaymentState`](GenericPolicyPaymentState.md)\>

### policies()

> **policies**(): [`CashuEscrowPaymentPolicy`](CashuEscrowPaymentPolicy.md)[]

#### Returns

[`CashuEscrowPaymentPolicy`](CashuEscrowPaymentPolicy.md)[]

### startup()

> **startup**(`context`): `Promise`\<`MarketplaceDriverStartResult` & `object`\>

#### Parameters

##### context

`MarketplaceDriverStartContext`

#### Returns

`Promise`\<`MarketplaceDriverStartResult` & `object`\>

### state()

> **state**(): [`CashuEscrowPolicyState`](CashuEscrowPolicyState.md)

#### Returns

[`CashuEscrowPolicyState`](CashuEscrowPolicyState.md)

### sweepPayment()

> **sweepPayment**(`payment`): `AsyncIterable`\<[`GenericPaymentSweepState`](GenericPaymentSweepState.md)\>

#### Parameters

##### payment

[`GenericPaymentSweepInput`](GenericPaymentSweepInput.md)

#### Returns

`AsyncIterable`\<[`GenericPaymentSweepState`](GenericPaymentSweepState.md)\>

### validatePayment()

> **validatePayment**(`request`): `Promise`\<[`GenericPaymentValidationResult`](GenericPaymentValidationResult.md)\>

#### Parameters

##### request

`MarketplaceDriverValidationRequest`

#### Returns

`Promise`\<[`GenericPaymentValidationResult`](GenericPaymentValidationResult.md)\>
