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
    checkedQuotes: [],
    onceMintPaid: [],
    p2pkOptions: [],
    recycleP2pkOptions: [],
  }
  const mockOutput = (amount, p2pkOptions) => ({
    blindedMessage: {
      amount: Amount.from(amount),
      B_: `02${'2'.repeat(64)}`,
      id: '009a1f293253e41e',
    },
    blindingFactor: 1n,
    secret: new TextEncoder().encode(p2pkSecretFromOptions(p2pkOptions)),
  })
  const wallet = {
    async loadMint() {},
    defaultOutputType() {
      return { type: 'random' }
    },
    getKeyset() {
      return {
        id: '009a1f293253e41e',
        keys: {
          1: 'key-1',
          2: 'key-2',
          5: 'key-5',
          10: 'key-10',
          20: 'key-20',
          50: 'key-50',
          100: 'key-100',
          200: 'key-200',
          500: 'key-500',
          1000: 'key-1000',
        },
      }
    },
    getFeesForKeyset() {
      return Amount.zero()
    },
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
      calls.checkedQuotes.push(typeof quote === 'string' ? quote : quote.quote)
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
    async prepareSwapToSend(amount, proofs, config, outputConfig) {
      calls.recycleP2pkOptions.push(outputConfig?.send?.options)
      return {
        amount: Amount.from(amount),
        fees: Amount.zero(),
        keysetId: '009a1f293253e41e',
        inputs: proofs,
        sendOutputs: [mockOutput(amount, outputConfig?.send?.options)],
        keepOutputs: [],
        unselectedProofs: [],
      }
    },
    signP2PKProofs(proofs) {
      return proofs.map((proof, index) => index === 0
        ? { ...proof, witness: { signatures: ['buyer-signature'] } }
        : proof)
    },
    async completeSwap(preview) {
      return {
        keep: preview.unselectedProofs ?? [],
        send: (preview.sendOutputs ?? []).map((output, index) => ({
          id: output.blindedMessage.id,
          amount: output.blindedMessage.amount,
          secret: new TextDecoder().decode(output.secret),
          C: `02${String(index + 3).repeat(64)}`,
        })),
      }
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

function createEscrowIntent(policy, overrides = {}) {
  const seed = overrides.seed ?? '2'.repeat(64)
  const accountIndex = overrides.accountIndex ?? 9
  const seller = deriveCashuEscrowKey(overrides.sellerSeed ?? '3'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const arbiter = deriveCashuEscrowKey(overrides.arbiterSeed ?? '4'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  return {
    method: 'cashu',
    purpose: 'order',
    tradeId: overrides.tradeId ?? 'trade-1',
    settlementId: overrides.settlementId ?? 'order-group-1',
    accountIndex,
    seed,
    amount: overrides.amount ?? { value: '10', denomination: 'SAT', decimals: 0 },
    fee: overrides.fee ?? { value: '2', denomination: 'SAT', decimals: 0 },
    asset: overrides.asset ?? {
      method: 'cashu',
      assetId: canonicalCashuAssetId(mint.mintUrl, mint.unit),
      denomination: 'SAT',
      decimals: 0,
      data: { mintUrl: mint.mintUrl, unit: mint.unit },
    },
    policy: overrides.policy ?? policy.policies()[0],
    contract: overrides.contract ?? { type: cashuEscrowPolicyType, params: {} },
    participants: overrides.participants ?? {
      seller: { data: { cashuPubkey: seller.publicKey } },
      arbiter: { data: { cashuPubkey: arbiter.publicKey } },
    },
    unlockAt: overrides.unlockAt ?? 1_800_000_000,
  }
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
  const arbiter = deriveCashuEscrowKey('4'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const intent = {
    method: 'cashu',
    purpose: 'order',
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
      arbiter: { data: { cashuPubkey: arbiter.publicKey } },
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
  assert.equal(proof.driver, cashuEscrowPolicyType)
  assert.equal(proof.params.policyType, cashuEscrowPolicyType)
  assert.equal(proof.params.policyHash, policy.policies()[0].hash)
  assert.notEqual(proof.params.conditionHash, proof.params.policyHash)

  const validation = await policy.validatePayment({
    driver: cashuEscrowPolicyType,
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
  assert.deepEqual(validation.amount, { value: intent.amount.value, denomination: 'BTC', decimals: 8 })
  assert.equal(validation.amountMatched, true)
  assert.equal(validation.assetMatched, true)
  assert.equal(validation.arbiterMatched, true)

  const btcValidation = await policy.validatePayment({
    driver: cashuEscrowPolicyType,
    proof,
    expected: {
      settlementId: intent.settlementId,
      tradeId: intent.tradeId,
      amount: { value: '10', denomination: 'BTC', decimals: 8 },
      fee: { value: '2', denomination: 'BTC', decimals: 8 },
      asset: { assetId: intent.asset.assetId, denomination: 'BTC', decimals: 8 },
    },
  })
  assert.equal(btcValidation.status, 'valid')
  assert.deepEqual(btcValidation.amount, { value: '10', denomination: 'BTC', decimals: 8 })
  assert.equal(btcValidation.amountMatched, true)
  assert.equal(btcValidation.assetMatched, true)
  assert.equal(btcValidation.arbiterMatched, true)

  const clearParams = proof.params
  const encryptedValidation = await policy.validatePayment({
    driver: cashuEscrowPolicyType,
    proof: {
      ...proof,
      params: {
        encrypted: true,
        version: 1,
        scheme: 'nip44',
        proofId: 'encrypted-cashu-proof-params',
        payload: 'sealed',
      },
    },
    decryptParams: async () => clearParams,
  })
  assert.equal(encryptedValidation.status, 'valid')
  assert.deepEqual(encryptedValidation.amount, { value: intent.amount.value, denomination: 'BTC', decimals: 8 })
  assert.equal(encryptedValidation.amountMatched, true)

  const operation = await store.get('cashu-escrow-order-group-1-9')
  assert.equal(operation?.status, 'completed')
  assert.equal(operation?.proofs?.length, 1)
})

test('waits for Cashu mint quote payment over websocket before slow polling', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  wallet.on = {
    async onceMintPaid(id, options) {
      calls.onceMintPaid.push({
        id,
        timeoutMs: options?.timeoutMs,
        hasSignal: Boolean(options?.signal),
      })
      return {
        quote: id,
        request: 'lnbcrt1cashuescrow',
        state: MintQuoteState.PAID,
        expiry: 1_800_000_000,
      }
    },
  }
  wallet.checkMintQuoteBolt11 = async quote => {
    calls.checkedQuotes.push(typeof quote === 'string' ? quote : quote.quote)
    throw new Error('poll should not run before websocket resolves')
  }
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 50,
    quotePaymentTimeoutMs: 1_000,
    now: () => 1_777_000_000_000,
  })

  const states = []
  for await (const state of policy.pay(createEscrowIntent(policy, {
    tradeId: 'trade-websocket',
    settlementId: 'order-websocket',
    accountIndex: 11,
  }))) states.push(state)

  assert.equal(states[3].type, 'paid')
  assert.equal(calls.onceMintPaid.length, 1)
  assert.equal(calls.onceMintPaid[0].id, 'quote-1')
  assert.equal(calls.onceMintPaid[0].hasSignal, true)
  assert.equal(calls.onceMintPaid[0].timeoutMs <= 1_000, true)
  assert.equal(calls.onceMintPaid[0].timeoutMs > 0, true)
  assert.deepEqual(calls.checkedQuotes, [])
})

test('falls back to slow polling when Cashu mint quote websocket wait fails', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  wallet.on = {
    async onceMintPaid(id, options) {
      calls.onceMintPaid.push({
        id,
        timeoutMs: options?.timeoutMs,
        hasSignal: Boolean(options?.signal),
      })
      throw new Error('websocket unavailable')
    },
  }
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
    now: () => 1_777_000_000_000,
  })

  const states = []
  for await (const state of policy.pay(createEscrowIntent(policy, {
    tradeId: 'trade-poll-fallback',
    settlementId: 'order-poll-fallback',
    accountIndex: 12,
  }))) states.push(state)

  assert.equal(states[3].type, 'paid')
  assert.equal(calls.onceMintPaid.length, 1)
  assert.equal(calls.onceMintPaid[0].id, 'quote-1')
  assert.deepEqual(calls.checkedQuotes, ['quote-1'])
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
  const arbiter = deriveCashuEscrowKey('4'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const intent = {
    method: 'cashu',
    purpose: 'order',
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
      arbiter: { data: { cashuPubkey: arbiter.publicKey } },
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
      arbiterPubkey: deriveCashuEscrowKey('7'.repeat(64), {
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
  const arbiter = deriveCashuEscrowKey('a'.repeat(64), {
    accountIndex: 0,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'settlement',
  })
  const intent = {
    method: 'cashu',
    purpose: 'bid',
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
      arbiter: { data: { cashuPubkey: arbiter.publicKey } },
    },
    unlockAt: 1_800_000_000,
    metadata: {
      targetOrderGroupId: 'target-order-group-1',
      targetOrder: { listingAnchor: '30402:listing-author:auction-listing', quantity: 1 },
    },
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
  assert.deepEqual(lockKeys, [buyer.publicKey, arbiter.publicKey])
  assert.deepEqual(calls.p2pkOptions[0].refundKeys, [buyer.publicKey])
  assert.ok(calls.p2pkOptions[0].additionalTags.some(tag => tag[0] === 'seller' && tag[1] === seller.publicKey))

  const proof = states[3].proof
  assert.equal(proof.params.policyType, cashuAuctionPolicyType)
  assert.equal(proof.params.policyHash, cashuAuctionPolicyHash({ mintUrl: mint.mintUrl, unit: mint.unit }))
  assert.equal(proof.params.recycleArgs.type, 'cashu:p2pk-auction-promote-v1')
  assert.equal(proof.params.recycleArgs.signerPubkey, buyer.publicKey)
  assert.equal(proof.params.recycleArgs.source.settlementId, intent.settlementId)
  assert.equal(proof.params.recycleArgs.target.settlementId, intent.metadata.targetOrderGroupId)
  assert.equal(proof.params.recycleArgs.target.policyType, cashuEscrowPolicyType)
  assert.equal(proof.params.recycleArgs.target.conditionHash, cashuEscrowPolicyHash({
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    locktime: intent.unlockAt,
    participants: {
      buyerPubkey: buyer.publicKey,
      sellerPubkey: seller.publicKey,
      arbiterPubkey: arbiter.publicKey,
    },
  }))
  assert.equal(proof.params.recycleArgs.target.participants.buyerPubkey, buyer.publicKey)
  assert.equal(proof.params.recycleArgs.target.order.listingAnchor, intent.metadata.targetOrder.listingAnchor)
  assert.equal(proof.params.recycleArgs.target.order.quantity, 1)
  assert.equal(proof.params.recycleArgs.swap.version, 1)
  assert.match(proof.params.recycleArgs.signature, /^[0-9a-f]{128}$/)
  const recycleLockKeys = Array.isArray(calls.recycleP2pkOptions[0].pubkey)
    ? calls.recycleP2pkOptions[0].pubkey
    : [calls.recycleP2pkOptions[0].pubkey]
  assert.deepEqual(recycleLockKeys, [buyer.publicKey, seller.publicKey, arbiter.publicKey])
  assert.deepEqual(calls.recycleP2pkOptions[0].refundKeys, [seller.publicKey])
  assert.ok(calls.recycleP2pkOptions[0].additionalTags.some(tag => tag[0] === 'policy' && tag[1] === cashuEscrowPolicyType))
  assert.ok(calls.recycleP2pkOptions[0].additionalTags.some(tag => tag[0] === 'settlement' && tag[1] === intent.metadata.targetOrderGroupId))

  const validation = await policy.validatePayment({
    driver: cashuAuctionPolicyType,
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
  assert.deepEqual(validation.amount, { value: intent.amount.value, denomination: 'BTC', decimals: 8 })
  assert.equal(validation.amountMatched, true)
  assert.equal(validation.assetMatched, true)
  assert.equal(validation.arbiterMatched, true)

  const promoted = await policy.recyclePayment({
    purpose: 'bid',
    action: 'auction_promote',
    seed: 'a'.repeat(64),
    proof,
    expected: { settlementId: intent.settlementId },
    targetTradeId: intent.tradeId,
    targetOrderGroupId: intent.metadata.targetOrderGroupId,
    recycleArgs: proof.params.recycleArgs,
  })
  assert.equal(promoted.proof.params.policyType, cashuEscrowPolicyType)
  assert.equal(promoted.proof.params.settlementId, intent.metadata.targetOrderGroupId)
  assert.equal(promoted.proof.params.tradeId, intent.tradeId)

  const escrowPolicy = createCashuEscrowPolicy({
    mints: [mint],
    storage: new MemoryCashuEscrowStore(),
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
    now: () => 1_777_000_000_000,
  })
  const promotedValidation = await escrowPolicy.validatePayment({
    driver: cashuEscrowPolicyType,
    proof: promoted.proof,
    expected: {
      settlementId: intent.metadata.targetOrderGroupId,
      tradeId: intent.tradeId,
      amount: intent.amount,
      fee: intent.fee,
      asset: { assetId: intent.asset.assetId, denomination: 'SAT', decimals: 0 },
    },
  })
  assert.equal(promotedValidation.status, 'valid')
  assert.equal(promotedValidation.arbiterMatched, true)

  const operation = await store.get('cashu-auction-0000000000000000000000000000000000000000000000000000000000000000-10')
  assert.equal(operation?.kind, 'cashu_auction_mint')
  assert.equal(operation?.status, 'completed')
})
