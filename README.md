# marketplace-cashu-ts

Nostr-agnostic Cashu payment policy package for marketplace escrow flows.

The package exports a structural `createCashuEscrowPolicy()` implementation
that can be passed to `nostr-tools.marketplace.init({ orderPolicies: [...] })`.
It does not import or know about Nostr events.

The current policy is Cashu escrow only. Auction support will be added as a
separate bid policy later.

## Shape

```ts
import { createCashuEscrowPolicy, MemoryCashuEscrowStore } from '@sudonym-btc/marketplace-cashu'

const cashuEscrowPolicy = createCashuEscrowPolicy({
  mints: [
    {
      mintUrl: 'http://127.0.0.1:19338',
      unit: 'sat',
      denomination: 'SAT',
      decimals: 0,
    },
  ],
  storage: new MemoryCashuEscrowStore(),
})
```

`pay(intent)` creates a Cashu BOLT11 mint quote, yields a `payment_required`
state with the invoice, waits for the quote to be paid, then mints P2PK-locked
escrow proofs and yields a `paid` state with a Cashu payment proof.

`recover(payment)` checks the proof state at the mint and returns progress or
recovered states. Cashu recovery from lost mint responses will use deterministic
restore outputs in the next iteration; this first policy stores quote state so
in-flight browser sessions can resume without coupling the marketplace app to
Cashu internals.
