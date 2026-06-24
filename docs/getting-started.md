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
```

## Add the driver to a marketplace runtime

```ts
const api = marketplace.bind(pool, relays, {
  seed: marketplaceSeed,
  publish,
  orderDrivers: [cashuPolicy],
  auctionDrivers: [cashuPolicy],
})
```

## Recover payment state

Cashu proofs contain enough policy and proof params to validate or recover a
published payment without device-local state. In-flight quotes can also resume
through the storage implementation supplied to the policy.

Read the generated [API reference](reference/README.md) for policy options,
proof storage, seed derivation, validation, and recovery types.
