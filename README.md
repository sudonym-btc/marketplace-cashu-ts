# marketplace-cashu-ts

Nostr-agnostic Cashu payment policy package for marketplace escrow flows.

## Docs

Package-owned docs live in [`docs`](docs/README.md) and are published at
<https://sudonym-btc.github.io/marketplace-cashu-ts/>. Start with
[`docs/getting-started.md`](docs/getting-started.md) and regenerate the API
reference with:

```sh
npm run docs:api
```

The package exports a structural `createCashuEscrowPolicy()` implementation
that can be passed to `nostr-tools.marketplace.session(pool, relays, signer, { orderPolicies: [...] })`.
It does not import or know about Nostr events.

The package provides separate order-escrow and auction-bid policies. Auction
promotion performs a prepared Cashu swap into the order lock. Auction refunds
are intentionally disabled until the protocol has a safe, idempotent transfer;
the driver throws instead of reporting a refund that did not move funds.

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

Use `createCashuAuctionPolicy()` independently for `auctionPolicies`.

`pay(intent)` creates a Cashu BOLT11 mint quote, yields a `payment_required`
state with the invoice, waits for the quote to be paid, then mints P2PK-locked
escrow proofs and yields a `paid` state with a Cashu payment proof. The proof
contains the stable policy hash for marketplace routing, a separate condition
hash for the concrete buyer/seller/escrow/locktime construction, and
self-contained params for validation: mint, unit, exact funded `amount`,
`paymentAmount`, `escrowFee`, participants, locktime, and serialized proofs.
Cashu proofs are bearer value, so both policies declare their proof parameters
`confidential`; a compatible runtime must seal them and must never publish the
clear parameters to a relay.

The validator does not require order or bid context. It resolves the proof
params, decrypting them through the shared driver `decryptParams` hook when
necessary, checks the Cashu proofs and P2PK policy, then returns the verified
`paymentAmount`. SAT-denominated proof amounts are exposed as BTC base units
(`denomination: "BTC"`, `decimals: 8`) for Nostr-facing payment data while the
Cashu mint `unit` remains `sat`.

`startup(context)` checks every active quote against its mint and updates the
recovery state. Retrying the same `pay(intent)` resumes the recorded quote and
uses deterministic P2PK outputs to recover a mint response lost after issuance.
The operation store contains an allowlisted request fingerprint, quote ID,
derivation index, and public policy metadata. It never stores completed bearer
proofs, marketplace seeds, private keys, or prepared-output secrets. Durable
storage implementations should implement atomic `create()` to prevent two
processes from opening a quote for the same operation.

The package expects participant identities to provide Cashu P2PK keys through
`data.cashuPubkey`, `data.cashuP2pkPubkey`, `data.p2pkPubkey`, or `address`.
The marketplace/Nostr layer decides how those identities are represented in
events; this package only receives the resolved intent.
