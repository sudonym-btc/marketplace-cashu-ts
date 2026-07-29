import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Amount,
  CheckStateEnum,
  MintQuoteState,
  OutputData,
  SigAll,
  createP2PKsecret,
  deserializeProofs,
  parseP2PKSecret,
  serializeProofs,
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
  cashuRefundAuthorization,
  cashuRefundP2pkOptions,
  cashuRefundPolicyType,
  deserializeCashuSwapPreview,
  proofPolicyMatches,
  serializeCashuSwapPreview,
} from '../dist/marketplace/proof.js'

const mint = {
  mintUrl: 'http://127.0.0.1:19338',
  unit: 'sat',
  denomination: 'SAT',
  decimals: 0,
}

// Generator point: the public key for mock mint scalar 1. Returning B_ as C_
// therefore models a valid blind signature for the unit tests.
const mockMintPublicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

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
    meltInvoices: [],
    meltedQuotes: [],
    meltedProofCounts: [],
    meltPrivkeys: [],
    signedProofCounts: [],
    signedPrivateKeys: [],
    preparedMintCount: 0,
    completedMintCount: 0,
    completedSwapCount: 0,
    restoredMintCount: 0,
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
          1: mockMintPublicKey,
          2: mockMintPublicKey,
          5: mockMintPublicKey,
          10: mockMintPublicKey,
          12: mockMintPublicKey,
          20: mockMintPublicKey,
          50: mockMintPublicKey,
          100: mockMintPublicKey,
          200: mockMintPublicKey,
          500: mockMintPublicKey,
          1000: mockMintPublicKey,
          1500: mockMintPublicKey,
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
    async createMeltQuoteBolt11(invoice) {
      calls.meltInvoices.push(invoice)
      return {
        quote: `melt-${calls.meltInvoices.length}`,
        request: invoice,
        amount: 10,
        fee_reserve: Amount.zero(),
        state: 'UNPAID',
        expiry: 1_800_000_000,
      }
    },
    async meltProofsBolt11(quote, proofs, config) {
      calls.meltedQuotes.push(quote.quote)
      calls.meltedProofCounts.push(proofs.length)
      calls.meltPrivkeys.push(config?.privkey)
      return {
        quote,
        change: [],
      }
    },
    ops: {
      mintBolt11(amount, quote) {
        let factory
        let keysetId
        const builder = {
          asP2PK(options) {
            calls.p2pkOptions.push(options)
            factory = value => mockOutput(value, options)
            return builder
          },
          asFactory(value) {
            factory = value
            return builder
          },
          keyset(value) {
            keysetId = value
            return builder
          },
          async prepare() {
            calls.preparedMintCount += 1
            const selectedKeyset = wallet.getKeyset(keysetId)
            const output = factory(amount, selectedKeyset)
            return {
              method: 'bolt11',
              payload: {
                quote: typeof quote === 'string' ? quote : quote.quote,
                outputs: [output.blindedMessage],
              },
              outputData: [output],
              keysetId: selectedKeyset.id,
              quote,
            }
          },
        }
        return builder
      },
    },
    async completeMint(preview) {
      calls.completedMintCount += 1
      return preview.outputData.map((output, index) => ({
        id: output.blindedMessage.id,
        amount: output.blindedMessage.amount,
        secret: new TextDecoder().decode(output.secret),
        C: `02${String(index + 1).repeat(64)}`,
      }))
    },
    mint: {
      async restore({ outputs }) {
        calls.restoredMintCount += 1
        return {
          outputs,
          signatures: outputs.map(output => ({
            id: output.id,
            amount: output.amount,
            C_: output.B_,
          })),
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
    signP2PKProofs(proofs, privateKey, outputs = []) {
      calls.signedProofCounts.push(proofs.length)
      calls.signedPrivateKeys.push(privateKey)
      const digest = SigAll.computeDigests(
        proofs,
        outputs.map(output => output.blindedMessage),
      ).current
      const signature = SigAll.signDigest(digest, privateKey)
      return proofs.map((proof, index) => index === 0
        ? { ...proof, witness: { signatures: [signature] } }
        : proof)
    },
    async completeSwap(preview) {
      calls.completedSwapCount += 1
      const sendOutputs = preview.sendOutputs ?? []
      const restored = await wallet.mint.restore({
        outputs: sendOutputs.map(output => output.blindedMessage),
      })
      const keyset = wallet.getKeyset(preview.keysetId)
      return {
        keep: preview.unselectedProofs ?? [],
        send: sendOutputs.map((output, index) => {
          const concrete = output instanceof OutputData
            ? output
            : OutputData.deserialize(OutputData.serialize(output))
          return concrete.toProof(restored.signatures[index], keyset)
        }),
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

function createAuctionIntent(policy, overrides = {}) {
  const seed = overrides.seed ?? '8'.repeat(64)
  const seller = deriveCashuEscrowKey(overrides.sellerSeed ?? '9'.repeat(64), {
    accountIndex: 0,
    role: 'settlement',
  })
  const arbiter = deriveCashuEscrowKey(overrides.arbiterSeed ?? 'a'.repeat(64), {
    accountIndex: 0,
    role: 'settlement',
  })
  return {
    method: 'cashu',
    purpose: 'bid',
    tradeId: overrides.tradeId ?? 'auction-trade-refund',
    settlementId: overrides.settlementId ?? 'b'.repeat(64),
    accountIndex: overrides.accountIndex ?? 30,
    seed,
    amount: overrides.amount ?? { value: '1500', denomination: 'SAT', decimals: 0 },
    fee: overrides.fee ?? { value: '0', denomination: 'SAT', decimals: 0 },
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
    unlockAt: overrides.unlockAt ?? 1_800_000_000,
    metadata: {
      targetOrderGroupId: overrides.targetOrderGroupId ?? 'target-order-refund',
      targetOrder: { listingAnchor: '30402:listing-author:auction-refund', quantity: 1 },
    },
  }
}

function mutateFirstCashuProof(paymentProof, mutate) {
  const proofs = deserializeProofs(paymentProof.params.proofs)
  proofs[0] = mutate(proofs[0])
  return {
    ...paymentProof,
    params: {
      ...paymentProof.params,
      proofs: serializeProofs(proofs),
    },
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
  assert.doesNotThrow(() => deriveCashuEscrowKey(seed, {
    accountIndex: 0xffff_ffff,
    role: 'buyer',
  }))
  assert.throws(() => deriveCashuEscrowKey(seed, {
    accountIndex: 0x1_0000_0000,
    role: 'buyer',
  }), /uint32/)
  assert.throws(() => deriveCashuEscrowKey(seed, {
    accountIndex: 1,
    keyIndex: 0x1_0000_0000,
    role: 'buyer',
  }), /uint32/)
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
  assert.equal('proofs' in operation, false)
  assert.equal('request' in operation, false)
  assert.equal(JSON.stringify(operation).includes(seed), false)
})

test('rejects non-canonical P2PK keys, tags, thresholds, and overfunding', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet } = createMockWallet()
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
  })
  const intent = createEscrowIntent(policy, { settlementId: 'canonical-order', accountIndex: 21 })
  const states = []
  for await (const state of policy.pay(intent)) states.push(state)
  const paymentProof = states.at(-1).proof
  const expected = {
    settlementId: intent.settlementId,
    tradeId: intent.tradeId,
    amount: intent.amount,
    fee: intent.fee,
    asset: { assetId: intent.asset.assetId, denomination: 'SAT', decimals: 0 },
  }
  const extraKey = deriveCashuEscrowKey('f'.repeat(64), {
    accountIndex: 0,
    role: 'settlement',
  }).publicKey
  const mutateTags = mutation => mutateFirstCashuProof(paymentProof, original => {
    const parsed = parseP2PKSecret(original.secret)
    return {
      ...original,
      secret: JSON.stringify(['P2PK', {
        ...parsed[1],
        tags: mutation(parsed[1].tags.map(tag => [...tag])),
      }]),
    }
  })
  const adversarialProofs = [
    mutateTags(tags => tags.map(tag => tag[0] === 'pubkeys' ? [...tag, extraKey] : tag)),
    mutateTags(tags => [...tags, [...tags.find(tag => tag[0] === 'refund')]]),
    mutateTags(tags => [...tags, ['unknown', 'attacker-controlled']]),
    mutateTags(tags => tags.map(tag => tag[0] === 'n_sigs' ? ['n_sigs', '1'] : tag)),
    mutateTags(tags => [...tags, ['n_sigs_refund', '1']]),
  ]
  for (const proof of adversarialProofs) {
    const result = await policy.validatePayment({
      driver: cashuEscrowPolicyType,
      proof,
      expected,
    })
    assert.equal(result.status, 'invalid')
    assert.equal(result.arbiterMatched, false)
  }

  const overfunded = mutateFirstCashuProof(paymentProof, proof => ({
    ...proof,
    amount: Amount.from(13),
  }))
  const amountResult = await policy.validatePayment({
    driver: cashuEscrowPolicyType,
    proof: overfunded,
    expected,
  })
  assert.equal(amountResult.status, 'invalid')
  assert.equal(amountResult.amountMatched, false)
  assert.match(amountResult.error, /amount mismatch/i)
})

test('marks Cashu payment proofs secret', () => {
  const { wallet } = createMockWallet()
  const escrow = createCashuEscrowPolicy({
    mints: [mint],
    storage: new MemoryCashuEscrowStore(),
    walletFactory: () => wallet,
  })
  const auction = createCashuAuctionPolicy({
    mints: [mint],
    storage: new MemoryCashuEscrowStore(),
    walletFactory: () => wallet,
  })
  assert.equal(escrow.proofSensitivity, 'secret')
  assert.equal(auction.proofSensitivity, 'secret')
})

test('sweeps unspent Cashu proofs to a withdrawal invoice', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  const withdrawalInvoices = []
  const seed = '2'.repeat(64)
  const accountIndex = 9
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
    withdrawals: {
      createInvoice(amount, description) {
        withdrawalInvoices.push({ amount, description })
        return `lnbcrt1withdraw${amount}`
      },
    },
    now: () => 1_777_000_000_000,
  })
  const payStates = []
  for await (const state of policy.pay(createEscrowIntent(policy, {
    tradeId: 'trade-sweep',
    settlementId: 'order-sweep',
    seed,
    accountIndex,
    amount: { value: '10', denomination: 'SAT', decimals: 0 },
    fee: { value: '0', denomination: 'SAT', decimals: 0 },
  }))) payStates.push(state)

  const sweepStates = []
  for await (const state of policy.sweepPayment({
    paymentId: 'payment-sweep',
    tradeId: 'trade-sweep',
    orderGroupId: 'order-sweep',
    listingAnchor: 'listing-sweep',
    createdAt: 1_777_000_010,
    seed,
    proof: payStates[3].proof,
  })) sweepStates.push(state)

  const buyer = deriveCashuEscrowKey(seed, {
    accountIndex,
    role: 'buyer',
  })
  assert.deepEqual(withdrawalInvoices, [{
    amount: 10,
    description: 'Marketplace Payout trade-sweep',
  }])
  assert.deepEqual(calls.meltPrivkeys, [buyer.privateKey])
  assert.deepEqual(calls.meltInvoices, ['lnbcrt1withdraw10'])
  assert.deepEqual(calls.meltedQuotes, ['melt-1'])
  assert.deepEqual(calls.meltedProofCounts, [1])
  assert.equal(sweepStates[0].type, 'progress')
  assert.equal(sweepStates.at(-1).type, 'swept')
  assert.equal(sweepStates.at(-1).data.amountSats, 10)
  assert.equal(sweepStates.at(-1).data.accountIndex, accountIndex)
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

test('reuses a persisted quote and reconciles it during startup', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  let quotePaid = false
  wallet.checkMintQuoteBolt11 = async quote => {
    const quoteId = typeof quote === 'string' ? quote : quote.quote
    calls.checkedQuotes.push(quoteId)
    return {
      quote: quoteId,
      request: 'lnbcrt1cashuescrow',
      unit: mint.unit,
      amount: Amount.from(12),
      state: quotePaid ? MintQuoteState.PAID : MintQuoteState.UNPAID,
      expiry: 1_800_000_000,
    }
  }
  const options = {
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 2,
  }
  const policy = createCashuEscrowPolicy(options)
  const intent = createEscrowIntent(policy, {
    tradeId: 'trade-retry',
    settlementId: 'order-retry',
    accountIndex: 22,
  })
  await assert.rejects(async () => {
    for await (const state of policy.pay(intent)) void state
  }, /Timed out waiting for Cashu mint quote payment/)
  assert.equal(calls.quoteAmounts.length, 1)
  assert.equal((await store.get('cashu-escrow-order-retry-22')).status, 'payment_required')

  quotePaid = true
  const restarted = createCashuEscrowPolicy(options)
  const startup = await restarted.startup({
    highWaterMark: 0,
    nextUnusedIndex: 1,
    unusedWindow: 20,
  })
  assert.equal(startup.data.recoveryActions[0].quoteState, MintQuoteState.PAID)
  assert.equal((await store.get('cashu-escrow-order-retry-22')).status, 'paid')

  const resumedStates = []
  for await (const state of restarted.pay(intent)) resumedStates.push(state)
  assert.equal(resumedStates.at(-1).type, 'paid')
  assert.equal(calls.quoteAmounts.length, 1)
  assert.equal((await store.get('cashu-escrow-order-retry-22')).status, 'completed')
})

test('fails closed when mint quote creation loses its response', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  const createQuote = wallet.createMintQuoteBolt11.bind(wallet)
  wallet.createMintQuoteBolt11 = async (...args) => {
    await createQuote(...args)
    throw new Error('connection lost after quote creation')
  }
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
  })
  const intent = createEscrowIntent(policy, {
    tradeId: 'trade-quote-uncertain',
    settlementId: 'order-quote-uncertain',
    accountIndex: 23,
  })
  await assert.rejects(async () => {
    for await (const state of policy.pay(intent)) void state
  }, /connection lost/)
  const operation = await store.get('cashu-escrow-order-quote-uncertain-23')
  assert.equal(operation.status, 'reconciliation_required')
  assert.equal(calls.quoteAmounts.length, 1)
  await assert.rejects(async () => {
    for await (const state of policy.pay(intent)) void state
  }, /refusing to create a replacement quote/i)
  assert.equal(calls.quoteAmounts.length, 1)
})

test('restores deterministic outputs after a lost mint response', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  let quoteState = MintQuoteState.PAID
  wallet.checkMintQuoteBolt11 = async quote => ({
    quote: typeof quote === 'string' ? quote : quote.quote,
    request: 'lnbcrt1cashuescrow',
    unit: mint.unit,
    amount: Amount.from(12),
    state: quoteState,
    expiry: 1_800_000_000,
  })
  wallet.completeMint = async () => {
    quoteState = MintQuoteState.ISSUED
    throw new Error('connection lost after mint accepted deterministic outputs')
  }
  const policy = createCashuEscrowPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
  })
  const intent = createEscrowIntent(policy, {
    tradeId: 'trade-mint-recovery',
    settlementId: 'order-mint-recovery',
    accountIndex: 24,
  })
  await assert.rejects(async () => {
    for await (const state of policy.pay(intent)) void state
  }, /connection lost after mint accepted/)
  assert.equal((await store.get('cashu-escrow-order-mint-recovery-24')).status, 'minting')

  const states = []
  for await (const state of policy.pay(intent)) states.push(state)
  assert.equal(states.at(-1).type, 'paid')
  assert.equal(calls.restoredMintCount, 1)
  assert.equal(calls.quoteAmounts.length, 1)
  const operation = await store.get('cashu-escrow-order-mint-recovery-24')
  assert.equal(operation.status, 'completed')
  assert.equal(JSON.stringify(operation).includes('secret'), false)
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
  wallet.getFeesForKeyset = () => Amount.from(1)
  const prepareSwap = wallet.prepareSwapToSend.bind(wallet)
  wallet.prepareSwapToSend = async (...args) => ({
    ...(await prepareSwap(...args)),
    fees: Amount.from(1),
  })
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
  assert.equal(calls.quoteAmounts[0], 1501n)
  const buyer = deriveCashuEscrowKey(seed, {
    accountIndex: intent.accountIndex,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'buyer',
  })
  const proof = states[3].proof
  assert.equal(proof.params.amount, '1501')
  assert.equal(proof.params.settlementAmount, '1500')
  assert.equal(proof.params.fundingFee, '1')
  const [bidProof] = deserializeProofs(proof.params.proofs)
  assert.equal(proofPolicyMatches(bidProof, {
    tradeId: intent.tradeId,
    settlementId: intent.settlementId,
    locktime: intent.unlockAt,
    policyType: cashuAuctionPolicyType,
    buyerPubkey: buyer.publicKey,
    sellerPubkey: seller.publicKey,
    arbiterPubkey: arbiter.publicKey,
  }), true)
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

  const promotionIntent = {
    purpose: 'bid',
    action: 'auction_promote',
    operationId: 'cashu-promote-1',
    seed: 'a'.repeat(64),
    proof,
    expected: { settlementId: intent.settlementId },
    targetTradeId: intent.tradeId,
    targetOrderGroupId: intent.metadata.targetOrderGroupId,
    recycleArgs: proof.params.recycleArgs,
  }
  const promoted = await policy.recyclePayment(promotionIntent)
  assert.equal(promoted.proof.params.policyType, cashuEscrowPolicyType)
  assert.equal(promoted.proof.params.settlementId, intent.metadata.targetOrderGroupId)
  assert.equal(promoted.proof.params.tradeId, intent.tradeId)
  assert.deepEqual(promoted.receipt.status, 'completed')
  assert.equal(promoted.receipt.operationId, 'cashu-promote-1')
  assert.match(promoted.receipt.externalId, /^[0-9a-f]{64}$/)

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

  wallet.checkProofsStates = async proofs => proofs.map(proof => ({
    Y: proof.secret,
    state: CheckStateEnum.SPENT,
  }))
  const recoveredPromotion = await policy.recyclePayment(promotionIntent)
  assert.equal(recoveredPromotion.receipt.operationId, promoted.receipt.operationId)
  assert.equal(recoveredPromotion.receipt.externalId, promoted.receipt.externalId)
  assert.deepEqual(recoveredPromotion.proof.params.proofs, promoted.proof.params.proofs)

  const operation = await store.get('cashu-auction-0000000000000000000000000000000000000000000000000000000000000000-10')
  assert.equal(operation?.kind, 'cashu_auction_mint')
  assert.equal(operation?.status, 'completed')
})

test('executes and idempotently restores a buyer-only Cashu auction refund', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  wallet.getFeesForKeyset = () => Amount.from(1)
  const prepareSwap = wallet.prepareSwapToSend.bind(wallet)
  wallet.prepareSwapToSend = async (...args) => ({
    ...(await prepareSwap(...args)),
    fees: Amount.from(1),
  })
  const policy = createCashuAuctionPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
  })
  const intent = createAuctionIntent(policy)
  const states = []
  for await (const state of policy.pay(intent)) states.push(state)
  const paymentProof = states.at(-1).proof
  assert.equal(paymentProof.params.refundArgs.type, 'cashu:p2pk-auction-refund-v1')
  assert.equal(paymentProof.params.refundArgs.refundPercent, 100)
  assert.equal(paymentProof.params.refundArgs.source.sourceValue, '1501')
  assert.equal(paymentProof.params.refundArgs.source.inputFee, '1')
  assert.equal(paymentProof.params.refundArgs.target.buyerOutputValue, '1500')

  const refundIntent = {
    purpose: 'bid',
    action: 'auction_refund',
    operationId: 'cashu-refund-1',
    seed: 'a'.repeat(64),
    refundPercent: 100,
    proof: paymentProof,
  }
  const refunded = await policy.refundPayment(refundIntent)
  assert.equal(refunded.proof.driver, cashuRefundPolicyType)
  assert.equal(refunded.receipt.operationId, refundIntent.operationId)
  assert.equal(refunded.receipt.evidence.sourceValue, '1501')
  assert.equal(refunded.receipt.evidence.inputFee, '1')
  assert.equal(refunded.receipt.evidence.buyerOutputValue, '1500')
  assert.equal(calls.completedSwapCount, 1)
  const [buyerProof] = deserializeProofs(refunded.proof.params.proofs)
  const buyer = deriveCashuEscrowKey(intent.seed, {
    accountIndex: intent.accountIndex,
    role: 'buyer',
  })
  const refundSecret = parseP2PKSecret(buyerProof.secret)
  assert.equal(refundSecret[1].data, buyer.publicKey)

  wallet.checkProofsStates = async proofs => proofs.map(proof => ({
    Y: proof.secret,
    state: CheckStateEnum.SPENT,
  }))
  const recovered = await policy.refundPayment(refundIntent)
  assert.equal(calls.completedSwapCount, 1)
  assert.equal(recovered.receipt.externalId, refunded.receipt.externalId)
  assert.deepEqual(recovered.proof.params.proofs, refunded.proof.params.proofs)

  await assert.rejects(policy.refundPayment({
    ...refundIntent,
    refundPercent: 99,
  }), /refundPercent=100/)
})

test('recovers an accepted Cashu refund after the mint response is lost', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  wallet.getFeesForKeyset = () => Amount.from(1)
  const prepareSwap = wallet.prepareSwapToSend.bind(wallet)
  wallet.prepareSwapToSend = async (...args) => ({
    ...(await prepareSwap(...args)),
    fees: Amount.from(1),
  })
  const policy = createCashuAuctionPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
  })
  const intent = createAuctionIntent(policy, {
    tradeId: 'auction-lost-refund-response',
    settlementId: 'e'.repeat(64),
    accountIndex: 32,
  })
  const states = []
  for await (const state of policy.pay(intent)) states.push(state)
  let sourceSpent = false
  wallet.checkProofsStates = async proofs => proofs.map(proof => ({
    Y: proof.secret,
    state: sourceSpent ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
  }))
  const completeSwap = wallet.completeSwap.bind(wallet)
  wallet.completeSwap = async (...args) => {
    await completeSwap(...args)
    sourceSpent = true
    throw new Error('connection lost after refund swap was accepted')
  }
  const refundIntent = {
    purpose: 'bid',
    action: 'auction_refund',
    operationId: 'cashu-refund-lost-response',
    seed: 'a'.repeat(64),
    refundPercent: 100,
    proof: states.at(-1).proof,
  }
  await assert.rejects(policy.refundPayment(refundIntent), /connection lost after refund swap/)
  assert.equal(calls.completedSwapCount, 1)

  const recovered = await policy.refundPayment(refundIntent)
  assert.equal(recovered.receipt.status, 'completed')
  assert.equal(recovered.receipt.operationId, refundIntent.operationId)
  assert.equal(recovered.receipt.evidence.buyerOutputValue, '1500')
  assert.equal(calls.completedSwapCount, 1)
})

test('rejects malicious Cashu refund packets before mint I/O', async () => {
  const store = new MemoryCashuEscrowStore()
  const { wallet, calls } = createMockWallet()
  wallet.getFeesForKeyset = () => Amount.from(1)
  const prepareSwap = wallet.prepareSwapToSend.bind(wallet)
  wallet.prepareSwapToSend = async (...args) => ({
    ...(await prepareSwap(...args)),
    fees: Amount.from(1),
  })
  const policy = createCashuAuctionPolicy({
    mints: [mint],
    storage: store,
    walletFactory: () => wallet,
    quotePollIntervalMs: 0,
    quotePaymentTimeoutMs: 1_000,
  })
  const intent = createAuctionIntent(policy, {
    tradeId: 'auction-malicious-refund',
    settlementId: 'c'.repeat(64),
    accountIndex: 31,
  })
  const states = []
  for await (const state of policy.pay(intent)) states.push(state)
  const paymentProof = states.at(-1).proof
  const originalArgs = paymentProof.params.refundArgs
  const buyer = deriveCashuEscrowKey(intent.seed, {
    accountIndex: intent.accountIndex,
    role: 'buyer',
  })
  const attacker = deriveCashuEscrowKey('d'.repeat(64), {
    accountIndex: 0,
    role: 'buyer',
  })
  const attackerOutput = OutputData.createSingleP2PKData(cashuRefundP2pkOptions({
    buyerPubkey: attacker.publicKey,
    tradeId: intent.tradeId,
    settlementId: intent.settlementId,
  }), Amount.from(1500), originalArgs.source.keysetId)
  const maliciousPreview = deserializeCashuSwapPreview(originalArgs.swap)
  const maliciousSwap = serializeCashuSwapPreview({
    ...maliciousPreview,
    inputs: wallet.signP2PKProofs(
      maliciousPreview.inputs,
      buyer.privateKey,
      [attackerOutput],
    ),
    sendOutputs: [attackerOutput],
  })
  const maliciousArgs = cashuRefundAuthorization({
    buyerPrivateKey: buyer.privateKey,
    buyerPubkey: buyer.publicKey,
    source: originalArgs.source,
    target: originalArgs.target,
    swap: maliciousSwap,
  })
  const maliciousProof = {
    ...paymentProof,
    params: {
      ...paymentProof.params,
      refundArgs: maliciousArgs,
    },
  }
  const completedBefore = calls.completedSwapCount
  await assert.rejects(policy.refundPayment({
    purpose: 'bid',
    action: 'auction_refund',
    operationId: 'cashu-malicious-refund',
    seed: 'a'.repeat(64),
    refundPercent: 100,
    proof: maliciousProof,
  }), /buyer-only and canonical/)
  assert.equal(calls.completedSwapCount, completedBefore)

  const tamperedValueProof = structuredClone(paymentProof)
  tamperedValueProof.params.refundArgs.source.inputFee = '2'
  await assert.rejects(policy.refundPayment({
    purpose: 'bid',
    action: 'auction_refund',
    operationId: 'cashu-tampered-refund',
    seed: 'a'.repeat(64),
    refundPercent: 100,
    proof: tamperedValueProof,
  }), /message is not canonical|values do not match/)
  assert.equal(calls.completedSwapCount, completedBefore)
})
