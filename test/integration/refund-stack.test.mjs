import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { CheckStateEnum, Wallet, deserializeProofs } from '@cashu/cashu-ts'

import {
  MemoryCashuEscrowStore,
  canonicalCashuAssetId,
  createCashuAuctionPolicy,
  deriveCashuEscrowKey,
} from '../../dist/index.js'

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the Cashu integration test`)
  return value
}

function digestHex(label, runId) {
  return createHash('sha256').update(`${label}:${runId}`).digest('hex')
}

function accountIndex(runId) {
  return Number.parseInt(digestHex('account', runId).slice(0, 8), 16)
}

async function activeKeyset(mintUrl, unit) {
  const response = await fetch(`${mintUrl.replace(/\/$/, '')}/v1/keysets`)
  if (!response.ok) throw new Error(`Unable to load Cashu keysets: HTTP ${response.status}`)
  const body = await response.json()
  const keysets = Array.isArray(body.keysets) ? body.keysets : []
  const keyset = keysets.find(candidate => candidate.active === true && candidate.unit === unit)
  if (!keyset || typeof keyset.id !== 'string') {
    throw new Error(`No active ${unit} Cashu keyset found`)
  }
  return keyset
}

function payRegtestInvoice(invoice) {
  const container = process.env.CASHU_TEST_PAYER_CONTAINER ?? 'marketplace-cashu-stack-lnd-buyer-1'
  execFileSync('docker', [
    'exec',
    '-i',
    container,
    'lncli',
    '--network=regtest',
    '--lnddir=/lnd',
    'payinvoice',
    '--force',
    '--fee_limit=1000',
    invoice,
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}

test('real mint enforces and NUT-09 restores the exact buyer refund outputs', { timeout: 180_000 }, async () => {
  const mintUrl = requiredEnv('CASHU_TEST_MINT_URL').replace(/\/$/, '')
  const runId = requiredEnv('CASHU_TEST_RUN_ID')
  const unit = process.env.CASHU_TEST_UNIT ?? 'sat'
  const denomination = process.env.CASHU_TEST_DENOMINATION ?? 'SAT'
  const decimals = Number(process.env.CASHU_TEST_DECIMALS ?? '0')
  const now = Number(requiredEnv('CASHU_TEST_NOW'))
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('CASHU_TEST_NOW must be Unix seconds')
  const locktime = now + 600
  const keyset = await activeKeyset(mintUrl, unit)
  const mint = {
    mintUrl,
    unit,
    denomination,
    decimals,
    // This test process operates the pinned local stack and promises not to
    // rotate the discovered keyset during its ten-minute settlement window.
    auctionKeysetPolicies: [{ keysetId: keyset.id, activeUntil: locktime + 60 }],
  }
  const buyerSeed = digestHex('buyer', runId)
  const sellerSeed = digestHex('seller', runId)
  const arbiterSeed = digestHex('arbiter', runId)
  const index = accountIndex(runId)
  const seller = deriveCashuEscrowKey(sellerSeed, { accountIndex: 0, role: 'settlement' })
  const arbiter = deriveCashuEscrowKey(arbiterSeed, { accountIndex: 0, role: 'settlement' })
  let loseNextSwapResponse = false
  const policy = createCashuAuctionPolicy({
    mints: [mint],
    storage: new MemoryCashuEscrowStore(),
    quotePollIntervalMs: 100,
    quotePaymentTimeoutMs: 60_000,
    now: () => now * 1000,
    walletFactory(config) {
      const wallet = new Wallet(config.mintUrl, { unit: config.unit })
      const completeSwap = wallet.completeSwap.bind(wallet)
      wallet.completeSwap = async (...args) => {
        const result = await completeSwap(...args)
        if (loseNextSwapResponse) {
          loseNextSwapResponse = false
          throw new Error('simulated lost response after real mint acceptance')
        }
        return result
      }
      return wallet
    },
  })
  const settlementId = digestHex('settlement', runId)
  const intent = {
    method: 'cashu',
    purpose: 'bid',
    tradeId: `cashu-refund-integration-${runId}`,
    settlementId,
    accountIndex: index,
    seed: buyerSeed,
    amount: { value: '20', denomination, decimals },
    fee: { value: '0', denomination, decimals },
    asset: {
      method: 'cashu',
      assetId: canonicalCashuAssetId(mintUrl, unit),
      denomination,
      decimals,
      data: { mintUrl, unit },
    },
    policy: policy.policies()[0],
    contract: { type: policy.id, params: {} },
    participants: {
      seller: { data: { cashuPubkey: seller.publicKey } },
      arbiter: { data: { cashuPubkey: arbiter.publicKey } },
    },
    unlockAt: locktime,
    metadata: {
      targetOrderGroupId: digestHex('target-order', runId),
      targetOrder: { listingAnchor: `30402:${digestHex('listing-author', runId)}:integration`, quantity: 1 },
    },
  }

  const iterator = policy.pay(intent)[Symbol.asyncIterator]()
  const paymentRequired = await iterator.next()
  assert.equal(paymentRequired.value?.type, 'payment_required')
  payRegtestInvoice(paymentRequired.value.request.bolt11)
  const states = [paymentRequired.value]
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    states.push(next.value)
  }
  const paymentProof = states.find(state => state.type === 'paid')?.proof
  assert.ok(paymentProof)

  const refundIntent = {
    purpose: 'bid',
    action: 'auction_refund',
    operationId: `refund:${settlementId}`,
    seed: arbiterSeed,
    refundPercent: 100,
    proof: paymentProof,
  }
  loseNextSwapResponse = true
  await assert.rejects(
    policy.refundPayment(refundIntent),
    /simulated lost response after real mint acceptance/,
  )
  const recovered = await policy.refundPayment(refundIntent)
  assert.equal(recovered.receipt.status, 'completed')
  assert.equal(recovered.receipt.operationId, refundIntent.operationId)
  const refundedProofs = deserializeProofs(recovered.proof.params.proofs)
  assert.ok(refundedProofs.length > 0)

  const wallet = new Wallet(mintUrl, { unit })
  await wallet.loadMint(true)
  const statesAfterRestore = await wallet.checkProofsStates(refundedProofs)
  assert.equal(statesAfterRestore.every(state => state.state === CheckStateEnum.UNSPENT), true)
})
