# marketplace-cashu-ts

Nostr-agnostic Cashu payment policy package for marketplace escrow flows.

Requires Node.js 22.4 or newer. NMDK aggregate development uses Node.js 24.

## Docs

Package-owned docs live in [`docs`](docs/README.md) and are published at
<https://sudonym-btc.github.io/marketplace-cashu-ts/>. Start with
[`docs/getting-started.md`](docs/getting-started.md) and regenerate the API
reference with:

```sh
npm run docs:api
```

The package exports a structural `createCashuEscrowPolicy()` implementation
that can be passed to `nostr-tools.marketplace.bind(pool, relays, { orderDrivers: [...] })`.
It does not import or know about Nostr events.

The package provides separate order-escrow and auction-bid policies. At bid
creation the buyer pre-authorizes two exact, mutually exclusive Cashu swaps:
promotion into the order lock and a 100% losing-bid refund into a buyer-only
P2PK output. The arbiter validates and co-signs the selected packet. Lost mint
responses are recovered from the committed outputs through NUT-09.

All configured mints must advertise NUT-11 before this package will fund,
validate, sweep, or settle a P2PK escrow. Auction mints must also advertise
NUT-09. These checks fail closed; a structured `P2PK` secret on a legacy mint
is not an escrow because the mint can otherwise treat it as ordinary bearer
value.

Cashu does not standardize a future keyset-inactivation schedule. Auction
configuration must therefore include exactly one operator commitment for the
active output keyset:

```ts
auctionKeysetPolicies: [{
  keysetId: '<active-keyset-id-from-/v1/keysets>',
  activeUntil: 1_800_000_000, // Unix seconds; at least the latest bid locktime
}]
```

The driver verifies the keyset is currently active, binds its ID and committed
horizon into the buyer-signed refund and promotion packets, and rechecks both
before settlement. Retain old policy entries until all bids using them expire.
NUT-02 `final_expiry` is only a final redemption deadline; it is not treated as
an active-through guarantee. A null `final_expiry` is valid but does not remove
the explicit operator-policy requirement.

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
Cashu proofs and pre-authorized swap packets contain bearer value, so both
policies declare the complete proof `secret`; a compatible runtime must seal
the whole proof and must never publish clear proof fields to a relay.

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

Auction refunds accept exactly `refundPercent: 100`. The completed receipt
separately reports the source value, Cashu mint input fee, and buyer output
value. “100%” means all value recoverable after the explicitly accounted mint
fee; it is never a silent percentage haircut.

The package expects participant identities to provide Cashu P2PK keys through
`data.cashuPubkey`, `data.cashuP2pkPubkey`, `data.p2pkPubkey`, or `address`.
The marketplace/Nostr layer decides how those identities are represented in
events; this package only receives the resolved intent.
