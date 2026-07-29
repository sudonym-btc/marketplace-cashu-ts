# Getting started with the Marketplace Cashu Driver

`@sudonym-btc/marketplace-cashu` implements Nostr-agnostic Cashu escrow payment
policies for marketplace orders and auctions. It creates P2PK-locked proofs,
validates payment proofs, and recovers published payment state from proof data.

## Install

```sh
npm install @sudonym-btc/marketplace-cashu
```

In the NMDK workspace, the package is consumed from the checked-out submodule.

## Configure a Cashu policy

```ts
import {
  createCashuAuctionPolicy,
  createCashuEscrowPolicy,
  MemoryCashuEscrowStore,
} from '@sudonym-btc/marketplace-cashu'

const cashuPolicy = createCashuEscrowPolicy({
  appId: 'marketplace',
  storage: new MemoryCashuEscrowStore(),
  mints: [
    {
      mintUrl: 'http://127.0.0.1:19338',
      unit: 'sat',
      denomination: 'BTC',
      decimals: 8,
    },
  ],
})

const cashuAuctionPolicy = createCashuAuctionPolicy({
  appId: 'marketplace',
  storage: new MemoryCashuEscrowStore(),
  mints: cashuPolicy.assets().map(asset => ({
    mintUrl: asset.data.mintUrl as string,
    unit: asset.data.unit as string,
    denomination: asset.denomination,
    decimals: asset.decimals,
  })),
})
```

## Add the driver to a marketplace runtime

```ts
const api = marketplace.bind(pool, relays, {
  seed: marketplaceSeed,
  publish,
  orderDrivers: [cashuPolicy],
  auctionDrivers: [cashuAuctionPolicy],
})
```

## Recover payment state

Cashu proofs and prepared settlement packets contain bearer value. The policies
require whole-proof sealing before publication. In-flight quotes
resume through the supplied storage implementation; the store retains only
public recovery metadata and never completed proofs or seeds. Implement atomic
`create()` in durable stores used by multiple processes.

Startup reconciles active quote states with the mint. Retrying the same payment
intent reuses its quote and deterministically reconstructs mint outputs, which
also permits NUT-09 restoration after a response is lost. A quote whose creation
response was lost is marked `reconciliation_required` rather than duplicated.

Auction promotion and 100% losing-bid refunds are supported. Both are prepared
and buyer-signed when the bid is funded, then validated and co-signed by the
arbiter. Refund receipts disclose the source value, Cashu input fee, and exact
buyer output value. Retrying the same settlement operation restores the same
buyer output through NUT-09 when the first mint response was lost.

Read the generated [API reference](reference/README.md) for policy options,
proof storage, seed derivation, validation, and recovery types.
