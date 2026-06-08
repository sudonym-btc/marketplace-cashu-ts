import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Amount,
  CheckStateEnum,
  MintQuoteState,
  createP2PKsecret,
} from '@cashu/cashu-ts'

import {
  CashuPaymentAmountLimitError,
  createCashuAuctionPolicy,
  createCashuEscrowPolicy,
} from '../dist/index.js'
import { MemoryCashuEscrowStore } from '../dist/storage.js'
import { deriveCashuEscrowKey } from '../dist/seed.js'
import {
  canonicalCashuAssetId,
  cashuAuctionPolicyHash,
  cashuAuctionPolicyType,
  cashuEscrowPolicyHash,
  cashuEscrowPolicyType,
} from '../dist/marketplace/proof.js'

const mint = {
  mintUrl: 'http://127.0.0.1:19338',
  unit: 'sat',
  denomination: 'SAT',
  decimals: 0,
}

function p2pkSecretFromOptions(options) {
  const lockKeys = Array.isArray(options.pubkey) ? options.pubkey : [options.pubkey]
  const tags = []
  if (Number.isSafeInteger(options.locktime)) tags.push(['locktime', String(options.locktime)])
  if (lockKeys.length > 1) tags.push(['pubkeys', ...lockKeys.slice(1)])
  if (options.requiredSignatures > 1) tags.push(['n_sigs', String(options.requiredSignatures)])
  if (options.refundKeys?.length) tags.push(['refund', ...options.refundKeys])
  if (options.requiredRefundSignatures > 1) tags.push(['n_sigs_refund', String(options.requiredRefundSignatures)])
  if (options.sigFlag) tags.push(['sigflag', options.sigFlag])
  if (options.additionalTags?.length) tags.push(...options.additionalTags)
  return createP2PKsecret(lockKeys[0], tags)
}

function createMockWallet() {
  const calls = {
    quoteAmounts: [],
    descriptions: [],
    p2pkOptions: [],
  }
  const wallet = {
    async loadMint() {},
    getMintInfo() {
      return {
        isSupported(num) {
          if (num === 4) {
            return {
              disabled: false,
              params: [{
                method: 'bolt11',
                unit: mint.unit,
                min_amount: null,
                max_amount: null,
                options: { description: true },
              }],
            }
          }
          return { supported: false }
        },
      }
    },
    async createMintQuoteBolt11(amount, description) {
      calls.quoteAmounts.push(amount)
      calls.descriptions.push(description)
      return {
        quote: 'quote-1',
        request: 'lnbcrt1cashuescrow',
        state: MintQuoteState.UNPAID,
        expiry: 1_800_000_000,
      }
    },
    async checkMintQuoteBolt11(quote) {
      return {
        quote: typeof quote === 'string' ? quote : quote.quote,
        request: 'lnbcrt1cashuescrow',
        state: MintQuoteState.PAID,
        expiry: 1_800_000_000,
      }
    },
    ops: {
      mintBolt11(amount, quote) {
        return {
          asP2PK(options) {
            calls.p2pkOptions.push(options)
            return {
              async run() {
                return [{
                  id: '009a1f293253e41e',
                  amount: Amount.from(amount),
                  secret: p2pkSecretFromOptions(options),
                  C: `02${'1'.repeat(64)}`,
                }]
              },
            }
          },
        }
      },
    },
    async checkProofsStates(proofs) {
      return proofs.map(proof => ({
        Y: proof.secret,
        state: CheckStateEnum.UNSPENT,
      }))
    },
  }
  return { wallet, calls }
}

test('derives stable Cashu escrow keys from seed and index', () => {
  const seed = '1'.repeat(64)
  const first = deriveCashuEscrowKey(seed, {
    accountIndex: 3,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'buyer',
  })
  const again = deriveCashuEscrowKey(seed, {
    accountIndex: 3,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'buyer',
  })
  const next = deriveCashuEscrowKey(seed, {
    accountIndex: 4,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'buyer',
  })

  assert.equal(first.privateKey.length, 64)
  assert.match(first.publicKey, /^0[23][0-9a-f]{64}$/)
  assert.deepEqual(first, again)
  assert.notEqual(first.publicKey, next.publicKey)
})

test('creates an escrow payment proof and validates unspent locked proofs', async () => {
  const seed = '2'.repeat(64)
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
    now: () => 1_777_000_000_000,
  })
  const seller = deriveCashuEscrowKey('3'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const escrow = deriveCashuEscrowKey('4'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const intent = {
    method: 'cashu',
    subject: 'order',
    tradeId: 'trade-1',
    settlementId: 'order-group-1',
    accountIndex: 9,
    seed,
    amount: { value: '10', denomination: 'SAT', decimals: 0 },
    fee: { value: '2', denomination: 'SAT', decimals: 0 },
    asset: {
      method: 'cashu',
      assetId: canonicalCashuAssetId(mint.mintUrl, mint.unit),
      denomination: 'SAT',
      decimals: 0,
      data: { mintUrl: mint.mintUrl, unit: mint.unit },
    },
    policy: policy.policies()[0],
    contract: { type: cashuEscrowPolicyType, params: {} },
    participants: {
      seller: { data: { cashuPubkey: seller.publicKey } },
      escrow: { data: { cashuPubkey: escrow.publicKey } },
    },
    unlockAt: 1_800_000_000,
  }

  const states = []
  for await (const state of policy.pay(intent)) states.push(state)

  assert.equal(states[0].type, 'payment_required')
  assert.equal(states[0].request.bolt11, 'lnbcrt1cashuescrow')
  assert.deepEqual(states[0].request.data.limits, {
    source: 'cashu-mint',
    method: 'bolt11',
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    amount: { value: '12', denomination: 'SAT', decimals: 0 },
    min: null,
    max: null,
  })
  assert.equal(states[1].type, 'payment_progress')
  assert.equal(states[2].type, 'payment_progress')
  assert.equal(states[3].type, 'paid')
  assert.equal(calls.quoteAmounts[0], 12n)
  assert.equal(calls.p2pkOptions[0].requiredSignatures, 2)
  assert.equal(calls.p2pkOptions[0].sigFlag, 'SIG_ALL')

  const proof = states[3].proof
  assert.equal(proof.method, 'cashu')
  assert.equal(proof.params.policyType, cashuEscrowPolicyType)
  assert.equal(proof.params.policyHash, policy.policies()[0].hash)
  assert.notEqual(proof.params.conditionHash, proof.params.policyHash)

  const validation = await policy.validatePayment({
    method: 'cashu',
    proof,
    expected: {
      settlementId: intent.settlementId,
      tradeId: intent.tradeId,
      amount: intent.amount,
      fee: intent.fee,
      asset: { assetId: intent.asset.assetId, denomination: 'SAT', decimals: 0 },
    },
  })
  assert.equal(validation.status, 'valid')
  assert.equal(validation.amountMatched, true)
  assert.equal(validation.assetMatched, true)
  assert.equal(validation.escrowMatched, true)

  const operation = await store.get('cashu-escrow-order-group-1-9')
  assert.equal(operation?.status, 'completed')
  assert.equal(operation?.proofs?.length, 1)
})

test('rejects Cashu payments outside advertised mint limits before quote creation', async () => {
  const seed = '2'.repeat(64)
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  wallet.getMintInfo = () => ({
    isSupported(num) {
      if (num === 4) {
        return {
          disabled: false,
          params: [{
            method: 'bolt11',
            unit: mint.unit,
            min_amount: 50,
            max_amount: 1000,
            options: { description: true },
          }],
        }
      }
      return { supported: false }
    },
  })
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
  })
  const seller = deriveCashuEscrowKey('3'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const escrow = deriveCashuEscrowKey('4'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const intent = {
    method: 'cashu',
    subject: 'order',
    tradeId: 'trade-low',
    settlementId: 'order-low',
    accountIndex: 9,
    seed,
    amount: { value: '10', denomination: 'SAT', decimals: 0 },
    fee: { value: '2', denomination: 'SAT', decimals: 0 },
    asset: {
      method: 'cashu',
      assetId: canonicalCashuAssetId(mint.mintUrl, mint.unit),
      denomination: 'SAT',
      decimals: 0,
      data: { mintUrl: mint.mintUrl, unit: mint.unit },
    },
    policy: policy.policies()[0],
    contract: { type: cashuEscrowPolicyType, params: {} },
    participants: {
      seller: { data: { cashuPubkey: seller.publicKey } },
      escrow: { data: { cashuPubkey: escrow.publicKey } },
    },
    unlockAt: 1_800_000_000,
  }

  await assert.rejects(
    async () => {
      for await (const state of policy.pay(intent)) void state
    },
    error => {
      assert.equal(error instanceof CashuPaymentAmountLimitError, true)
      assert.equal(error.reason, 'below_minimum')
      assert.equal(error.limits.min.value, '50')
      assert.equal(error.limits.amount.value, '12')
      return true
    },
  )
  assert.deepEqual(calls.quoteAmounts, [])
})

test('uses a stable policy hash for routing and a separate condition hash for each trade', () => {
  const staticHash = cashuEscrowPolicyHash({ mintUrl: mint.mintUrl, unit: mint.unit })
  const tradeHash = cashuEscrowPolicyHash({
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    locktime: 123,
    participants: {
      buyerPubkey: deriveCashuEscrowKey('5'.repeat(64), {
        accountIndex: 0,
        mintUrl: mint.mintUrl,
        unit: mint.unit,
        role: 'buyer',
      }).publicKey,
      sellerPubkey: deriveCashuEscrowKey('6'.repeat(64), {
        accountIndex: 0,
        mintUrl: mint.mintUrl,
        unit: mint.unit,
        role: 'settlement',
      }).publicKey,
      escrowPubkey: deriveCashuEscrowKey('7'.repeat(64), {
        accountIndex: 0,
        mintUrl: mint.mintUrl,
        unit: mint.unit,
        role: 'settlement',
      }).publicKey,
    },
  })

  assert.match(staticHash, /^0x[0-9a-f]{64}$/)
  assert.match(tradeHash, /^0x[0-9a-f]{64}$/)
  assert.notEqual(staticHash, tradeHash)
})

test('creates an auction bid proof with the same Cashu payment shape', async () => {
  const seed = '8'.repeat(64)
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  const policy = createCashuAuctionPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
    now: () => 1_777_000_000_000,
  })
  const seller = deriveCashuEscrowKey('9'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const escrow = deriveCashuEscrowKey('a'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const intent = {
    method: 'cashu',
    subject: 'bid',
    tradeId: 'auction-trade-1',
    settlementId: '0'.repeat(64),
    accountIndex: 10,
    seed,
    amount: { value: '1500', denomination: 'SAT', decimals: 0 },
    fee: { value: '0', denomination: 'SAT', decimals: 0 },
    asset: {
      method: 'cashu',
      assetId: canonicalCashuAssetId(mint.mintUrl, mint.unit),
      denomination: 'SAT',
      decimals: 0,
      data: { mintUrl: mint.mintUrl, unit: mint.unit },
    },
    policy: policy.policies()[0],
    contract: { type: cashuAuctionPolicyType, params: {} },
    participants: {
      seller: { data: { cashuPubkey: seller.publicKey } },
      escrow: { data: { cashuPubkey: escrow.publicKey } },
    },
    unlockAt: 1_800_000_000,
  }

  const states = []
  for await (const state of policy.pay(intent)) states.push(state)

  assert.equal(states[0].type, 'payment_required')
  assert.equal(states[3].type, 'paid')
  assert.equal(calls.quoteAmounts[0], 1500n)
  assert.equal(calls.p2pkOptions[0].requiredSignatures, 2)
  assert.equal(calls.p2pkOptions[0].requiredRefundSignatures ?? 1, 1)
  assert.equal(calls.p2pkOptions[0].sigFlag, 'SIG_ALL')

  const buyer = deriveCashuEscrowKey(seed, {
    accountIndex: intent.accountIndex,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'buyer',
  })
  const lockKeys = Array.isArray(calls.p2pkOptions[0].pubkey)
    ? calls.p2pkOptions[0].pubkey
    : [calls.p2pkOptions[0].pubkey]
  assert.deepEqual(lockKeys, [buyer.publicKey, escrow.publicKey])
  assert.deepEqual(calls.p2pkOptions[0].refundKeys, [buyer.publicKey])
  assert.ok(calls.p2pkOptions[0].additionalTags.some(tag => tag[0] === 'seller' && tag[1] === seller.publicKey))

  const proof = states[3].proof
  assert.equal(proof.params.policyType, cashuAuctionPolicyType)
  assert.equal(proof.params.policyHash, cashuAuctionPolicyHash({ mintUrl: mint.mintUrl, unit: mint.unit }))
  assert.equal(proof.params.recycleArgs.type, 'cashu:p2pk-auction-promote-v1')
  assert.equal(proof.params.recycleArgs.signerPubkey, buyer.publicKey)
  assert.equal(proof.params.recycleArgs.target.settlementId, `${intent.settlementId}:escrow`)
  assert.equal(proof.params.recycleArgs.target.participants.buyerPubkey, buyer.publicKey)
  assert.match(proof.params.recycleArgs.signature, /^[0-9a-f]{128}$/)

  const validation = await policy.validatePayment({
    method: 'cashu',
    proof,
    expected: {
      settlementId: intent.settlementId,
      tradeId: intent.tradeId,
      amount: intent.amount,
      fee: intent.fee,
      asset: { assetId: intent.asset.assetId, denomination: 'SAT', decimals: 0 },
    },
  })
  assert.equal(validation.status, 'valid')
  assert.equal(validation.amountMatched, true)
  assert.equal(validation.assetMatched, true)
  assert.equal(validation.escrowMatched, true)

  const operation = await store.get('cashu-auction-0000000000000000000000000000000000000000000000000000000000000000-10')
  assert.equal(operation?.kind, 'cashu_auction_mint')
  assert.equal(operation?.status, 'completed')
})
