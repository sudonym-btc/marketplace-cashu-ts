# marketplace-cashu-ts

Nostr-agnostic Cashu payment policy package for marketplace escrow flows.

The package exports a structural `createCashuEscrowPolicy()` implementation
that can be passed to `nostr-tools.marketplace.session(pool, relays, signer, { orderPolicies: [...] })`.
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
escrow proofs and yields a `paid` state with a Cashu payment proof. The proof
contains the stable policy hash for marketplace routing and a separate
condition hash for the concrete buyer/seller/escrow/locktime construction.

`recover(payment)` checks the proof state at the mint and returns progress or
recovered states. Published payments can be recovered from the payment proof
without device-local Cashu knowledge; in-flight quotes are also stored through
the supplied storage interface so a browser session can resume without coupling
the marketplace app to Cashu internals.

The package expects participant identities to provide Cashu P2PK keys through
`data.cashuPubkey`, `data.cashuP2pkPubkey`, `data.p2pkPubkey`, or `address`.
The marketplace/Nostr layer decides how those identities are represented in
events; this package only receives the resolved intent.
