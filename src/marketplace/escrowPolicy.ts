import {
  MintQuoteState,
  Wallet,
  type MintQuoteBolt11Response,
} from '@cashu/cashu-ts'

import { deriveCashuEscrowKey } from '../seed.js'
import type { CashuEscrowStorage } from '../storage.js'
import type {
  CashuAmount,
  CashuEscrowPolicy,
  CashuEscrowPolicyState,
  CashuMintConfig,
  GenericPaymentIdentity,
  GenericPaymentIntent,
  GenericPaymentValidationRequest,
  GenericPaymentValidationResult,
  GenericPolicyPaymentState,
} from '../types.js'
import {
  anyProofPending,
  canonicalCashuAssetId,
  cashuEscrowP2pkOptions,
  cashuEscrowPolicyHash,
  cashuEscrowPolicyType,
  cashuPaymentProof,
  everyProofUnspent,
  proofAmount,
  proofPolicyMatches,
  proofStates,
  proofsFromPaymentProof,
  type CashuEscrowParticipants,
} from './proof.js'

export type CashuEscrowPolicyOptions = {
  mints: CashuMintConfig[]
  storage: CashuEscrowStorage
  appId?: string
  quotePollIntervalMs?: number
  quotePaymentTimeoutMs?: number
  walletFactory?: (mint: CashuMintConfig) => Wallet
  now?: () => number
}

const defaultPollIntervalMs = 2_000
const defaultPaymentTimeoutMs = 20 * 60_000

function nowSeconds(now = Date.now): number {
  return Math.floor(now() / 1000)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function amount(input: { value: string; denomination: string; decimals: number }): CashuAmount {
  return {
    value: BigInt(input.value),
    denomination: input.denomination,
    decimals: input.decimals,
  }
}

function identityCashuPubkey(identity: GenericPaymentIdentity | undefined, label: string): string {
  const data = identity?.data ?? {}
  const value =
    data.cashuPubkey ??
    data.cashuP2pkPubkey ??
    data.p2pkPubkey ??
    identity?.address
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${label} Cashu pubkey`)
  return value
}

function mintForIntent(mints: CashuMintConfig[], intent: GenericPaymentIntent): CashuMintConfig {
  const mintUrl = typeof intent.asset.data?.mintUrl === 'string'
    ? intent.asset.data.mintUrl
    : typeof intent.policy.data?.mintUrl === 'string'
      ? intent.policy.data.mintUrl
      : undefined
  const unit = typeof intent.asset.data?.unit === 'string'
    ? intent.asset.data.unit
    : typeof intent.policy.data?.unit === 'string'
      ? intent.policy.data.unit
      : undefined
  const assetId = intent.asset.assetId
  const mint = mints.find(candidate =>
    candidate.denomination === intent.asset.denomination &&
    (!mintUrl || candidate.mintUrl === mintUrl) &&
    (!unit || candidate.unit === unit) &&
    canonicalCashuAssetId(candidate.mintUrl, candidate.unit) === assetId,
  ) ?? mints.find(candidate => candidate.denomination === intent.asset.denomination)
  if (!mint) throw new Error(`No Cashu mint configured for ${intent.asset.denomination}`)
  return mint
}

function resolveIntent(mints: CashuMintConfig[], intent: GenericPaymentIntent) {
  if (intent.method !== 'cashu') throw new Error(`Cashu escrow policy cannot pay ${intent.method} intent`)
  if (intent.subject !== 'order') throw new Error(`Cashu escrow policy cannot pay ${intent.subject} intents`)
  if (!intent.seed) throw new Error('Cashu escrow payment requires a marketplace seed')
  const mint = mintForIntent(mints, intent)
  const paymentAmount = amount(intent.amount)
  const escrowFee = amount(intent.fee)
  const totalAmount: CashuAmount = {
    value: paymentAmount.value + escrowFee.value,
    denomination: paymentAmount.denomination,
    decimals: paymentAmount.decimals,
  }
  const buyerKey = deriveCashuEscrowKey(intent.seed, {
    accountIndex: intent.accountIndex,
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    role: 'buyer',
  })
  const participants: CashuEscrowParticipants = {
    buyerPubkey: buyerKey.publicKey,
    sellerPubkey: identityCashuPubkey(intent.participants.seller, 'seller'),
    escrowPubkey: identityCashuPubkey(intent.participants.escrow, 'escrow'),
  }
  const locktime = intent.unlockAt
  const policyHash = mint.policyHash ?? cashuEscrowPolicyHash({ mintUrl: mint.mintUrl, unit: mint.unit })
  const conditionHash = cashuEscrowPolicyHash({
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    locktime,
    participants,
  })
  return {
    mint,
    paymentAmount,
    escrowFee,
    totalAmount,
    buyerKey,
    participants,
    locktime,
    policyHash,
    conditionHash,
  }
}

async function waitForPaidQuote(
  wallet: Wallet,
  quote: MintQuoteBolt11Response,
  options: { pollIntervalMs: number; timeoutMs: number },
): Promise<MintQuoteBolt11Response> {
  const deadline = Date.now() + options.timeoutMs
  let latest = quote
  while (Date.now() < deadline) {
    latest = await wallet.checkMintQuoteBolt11(quote.quote)
    if (latest.state === MintQuoteState.PAID || latest.state === MintQuoteState.ISSUED) return latest
    await sleep(options.pollIntervalMs)
  }
  throw new Error(`Timed out waiting for Cashu mint quote payment; last state: ${latest.state}`)
}

function mintedProofsData(proof: GenericPaymentValidationRequest['proof']) {
  const mint = proof.params.mint
  const unit = proof.params.unit
  const amount = proof.params.amount
  const participants = proof.params.participants
  if (typeof mint !== 'string') throw new Error('Cashu proof missing mint')
  if (typeof unit !== 'string') throw new Error('Cashu proof missing unit')
  if (typeof amount !== 'string') throw new Error('Cashu proof missing amount')
  if (!participants || typeof participants !== 'object') throw new Error('Cashu proof missing participants')
  return {
    mint,
    unit,
    amount: BigInt(amount),
    participants: participants as CashuEscrowParticipants,
  }
}

export function createCashuEscrowPolicy(options: CashuEscrowPolicyOptions): CashuEscrowPolicy {
  const pollIntervalMs = options.quotePollIntervalMs ?? defaultPollIntervalMs
  const paymentTimeoutMs = options.quotePaymentTimeoutMs ?? defaultPaymentTimeoutMs
  const walletFactory = options.walletFactory ?? ((mint: CashuMintConfig) => new Wallet(mint.mintUrl, { unit: mint.unit }))
  let currentState: CashuEscrowPolicyState = {
    enabled: options.mints.length > 0,
    started: false,
    mintCount: options.mints.length,
    startSummary: 'Not started',
  }

  return {
    method: 'cashu',
    id: cashuEscrowPolicyType,
    subject: 'order',
    family: 'escrow',
    policies: () => options.mints.map(mint => ({
      method: 'cashu',
      id: canonicalCashuAssetId(mint.mintUrl, mint.unit),
      type: cashuEscrowPolicyType,
      hash: mint.policyHash ?? cashuEscrowPolicyHash({ mintUrl: mint.mintUrl, unit: mint.unit }),
      data: {
        mintUrl: mint.mintUrl,
        unit: mint.unit,
        ...(mint.data ?? {}),
      },
    })),
    assets: () => options.mints.map(mint => ({
      method: 'cashu',
      assetId: canonicalCashuAssetId(mint.mintUrl, mint.unit),
      denomination: mint.denomination,
      decimals: mint.decimals,
      ...(options.appId ? { appId: options.appId } : {}),
      data: {
        mintUrl: mint.mintUrl,
        unit: mint.unit,
        ...(mint.data ?? {}),
      },
    })),

    async discoverHighWatermark(context) {
      return {
        policy: cashuEscrowPolicyType,
        maxUsedIndex: context.highWaterMark,
        nextUnusedIndex: context.highWaterMark + 1,
        scannedFrom: context.highWaterMark + 1,
        scannedThrough: context.highWaterMark,
        unusedWindow: context.unusedWindow,
        usedIndexes: [],
        recoveryActions: [],
      }
    },

    async startup(context) {
      const activeOperations = await options.storage.list({
        status: ['quote_created', 'payment_required', 'minting'],
      })
      currentState = {
        enabled: options.mints.length > 0,
        started: true,
        mintCount: options.mints.length,
        startSummary: `${activeOperations.length} active Cashu escrow operation(s) available for recovery`,
      }
      return {
        policy: cashuEscrowPolicyType,
        data: {
          mintCount: options.mints.length,
          activeOperations: activeOperations.length,
          highWaterMark: context.highWaterMark,
          nextUnusedIndex: context.nextUnusedIndex,
        },
      }
    },

    async *recover(payment) {
      if (payment.proof.method !== 'cashu') {
        yield { type: 'noop', data: { reason: `Cashu policy cannot recover ${payment.proof.method}` } }
        return
      }
      try {
        const data = mintedProofsData(payment.proof)
        const wallet = walletFactory({ mintUrl: data.mint, unit: data.unit, denomination: '', decimals: 0 })
        await wallet.loadMint()
        const proofs = proofsFromPaymentProof(payment.proof)
        const states = await proofStates(wallet, proofs)
        if (everyProofUnspent(states)) {
          yield {
            type: 'recovered',
            data: {
              mint: data.mint,
              unit: data.unit,
              amount: data.amount.toString(),
              proofCount: proofs.length,
              states,
            },
          }
          return
        }
        if (anyProofPending(states)) {
          yield {
            type: 'progress',
            status: 'Cashu proofs are pending at the mint',
            data: { mint: data.mint, unit: data.unit, states },
          }
          return
        }
        yield {
          type: 'noop',
          data: { mint: data.mint, unit: data.unit, states },
        }
      } catch (error) {
        yield {
          type: 'noop',
          data: {
            reason: error instanceof Error ? error.message : 'Unable to recover Cashu payment',
          },
        }
      }
    },

    async *pay(intent: GenericPaymentIntent): AsyncIterable<GenericPolicyPaymentState> {
      const resolved = resolveIntent(options.mints, intent)
      const wallet = walletFactory(resolved.mint)
      await wallet.loadMint()
      const createdAt = nowSeconds(options.now)
      const operationId = `cashu-escrow-${intent.settlementId}-${intent.accountIndex}`
      const description = `Marketplace Cashu escrow ${intent.settlementId}`
      const quote = await wallet.createMintQuoteBolt11(resolved.totalAmount.value, description)
      await options.storage.put({
        id: operationId,
        kind: 'cashu_escrow_mint',
        status: 'payment_required',
        tradeId: intent.tradeId,
        settlementId: intent.settlementId,
        accountIndex: intent.accountIndex,
        mintUrl: resolved.mint.mintUrl,
        unit: resolved.mint.unit,
        quoteId: quote.quote,
        request: quote.request,
        data: {
          policyType: cashuEscrowPolicyType,
          policyHash: resolved.policyHash,
          conditionHash: resolved.conditionHash,
          buyerCashuPubkey: resolved.participants.buyerPubkey,
          sellerCashuPubkey: resolved.participants.sellerPubkey,
          escrowCashuPubkey: resolved.participants.escrowPubkey,
          locktime: resolved.locktime,
        },
        createdAt,
        updatedAt: createdAt,
      })

      yield {
        type: 'payment_required',
        request: {
          type: 'bolt11',
          bolt11: quote.request,
          amount: {
            value: resolved.totalAmount.value.toString(),
            denomination: resolved.totalAmount.denomination,
            decimals: resolved.totalAmount.decimals,
          },
          description,
          ...(quote.expiry ? { expiresAt: quote.expiry } : {}),
          data: {
            method: 'cashu',
            policyType: cashuEscrowPolicyType,
            mint: resolved.mint.mintUrl,
            unit: resolved.mint.unit,
            quoteId: quote.quote,
            tradeIndex: intent.accountIndex,
            buyerCashuPubkey: resolved.participants.buyerPubkey,
          },
        },
        proof: null,
        data: {
          method: 'cashu',
          policyType: cashuEscrowPolicyType,
          mint: resolved.mint.mintUrl,
          quoteId: quote.quote,
          tradeIndex: intent.accountIndex,
        },
      }

      yield {
        type: 'payment_progress',
        status: 'Waiting for Cashu mint quote payment',
        data: { method: 'cashu', mint: resolved.mint.mintUrl, quoteId: quote.quote },
      }

      const paidQuote = await waitForPaidQuote(wallet, quote, {
        pollIntervalMs,
        timeoutMs: paymentTimeoutMs,
      })
      await options.storage.put({
        ...(await options.storage.get(operationId))!,
        status: 'minting',
        updatedAt: nowSeconds(options.now),
      })
      yield {
        type: 'payment_progress',
        status: 'Mint quote paid; minting escrow proofs',
        data: { method: 'cashu', mint: resolved.mint.mintUrl, quoteId: paidQuote.quote },
      }

      const proofs = await wallet.ops
        .mintBolt11(resolved.totalAmount.value, paidQuote)
        .asP2PK(cashuEscrowP2pkOptions({
          tradeId: intent.tradeId,
          settlementId: intent.settlementId,
          locktime: resolved.locktime,
          ...resolved.participants,
        }))
        .run()
      const proof = cashuPaymentProof({
        mintUrl: resolved.mint.mintUrl,
        unit: resolved.mint.unit,
        amount: resolved.totalAmount,
        escrowFee: resolved.escrowFee,
        tradeId: intent.tradeId,
        settlementId: intent.settlementId,
        quoteId: paidQuote.quote,
        proofs,
        participants: resolved.participants,
        locktime: resolved.locktime,
        policyHash: resolved.policyHash,
        conditionHash: resolved.conditionHash,
      })
      await options.storage.put({
        ...(await options.storage.get(operationId))!,
        status: 'completed',
        proofs: proof.params.proofs as string[],
        updatedAt: nowSeconds(options.now),
      })
      yield {
        type: 'paid',
        proof,
        data: {
          method: 'cashu',
          policyType: cashuEscrowPolicyType,
          mint: resolved.mint.mintUrl,
          quoteId: paidQuote.quote,
          proofCount: proofs.length,
          amount: resolved.totalAmount.value.toString(),
        },
      }
    },

    async validatePayment(request: GenericPaymentValidationRequest): Promise<GenericPaymentValidationResult> {
      if (request.method !== 'cashu' || request.proof.method !== 'cashu') {
        return { method: 'cashu', status: 'unverifiable', error: `Cashu validator cannot validate ${request.method}` }
      }
      try {
        const data = mintedProofsData(request.proof)
        const locktime = Number(request.proof.params.locktime)
        const expectedAmount =
          (request.expected.amount ? BigInt(request.expected.amount.value) : data.amount) +
          (request.expected.fee ? BigInt(request.expected.fee.value) : 0n)
        const proofs = proofsFromPaymentProof(request.proof)
        const amountMatched = proofAmount(proofs) >= expectedAmount
        const assetMatched =
          (!request.expected.asset?.assetId || request.expected.asset.assetId === canonicalCashuAssetId(data.mint, data.unit)) &&
          (!request.expected.asset?.denomination || request.expected.asset.denomination === request.proof.params.denomination)
        const policyMatched = proofs.every(proof => proofPolicyMatches(proof, {
          tradeId: request.expected.tradeId ?? String(request.proof.params.tradeId ?? ''),
          settlementId: request.expected.settlementId,
          locktime,
          ...data.participants,
        }))
        const wallet = walletFactory({ mintUrl: data.mint, unit: data.unit, denomination: '', decimals: 0 })
        await wallet.loadMint()
        const states = await proofStates(wallet, proofs)
        const unspent = everyProofUnspent(states)
        if (!amountMatched) return { method: 'cashu', status: 'invalid', amountMatched, assetMatched, escrowMatched: policyMatched, error: 'Cashu amount mismatch' }
        if (!assetMatched) return { method: 'cashu', status: 'invalid', amountMatched, assetMatched, escrowMatched: policyMatched, error: 'Cashu asset mismatch' }
        if (!policyMatched) return { method: 'cashu', status: 'invalid', amountMatched, assetMatched, escrowMatched: false, error: 'Cashu escrow policy mismatch' }
        return {
          method: 'cashu',
          status: unspent ? 'valid' : anyProofPending(states) ? 'pending' : 'invalid',
          amountMatched,
          assetMatched,
          recipientMatched: true,
          escrowMatched: policyMatched,
          data: {
            mint: data.mint,
            unit: data.unit,
            proofCount: proofs.length,
            states,
          },
          ...(unspent ? {} : { error: 'Cashu proofs are not all unspent' }),
        }
      } catch (error) {
        return {
          method: 'cashu',
          status: 'unverifiable',
          error: error instanceof Error ? error.message : 'Unable to validate Cashu payment',
        }
      }
    },

    state() {
      return currentState
    },
  }
}
