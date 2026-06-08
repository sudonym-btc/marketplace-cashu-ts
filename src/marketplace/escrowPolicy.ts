import {
  MintQuoteState,
  Wallet,
  type MintQuoteBolt11Response,
} from '@cashu/cashu-ts'

import { deriveCashuEscrowKey } from '../seed.js'
import type { CashuEscrowStorage } from '../storage.js'
import type {
  CashuAmount,
  CashuAuctionPaymentPolicy,
  CashuAuctionPolicy,
  CashuAuctionPolicyState,
  CashuEscrowPaymentPolicy,
  CashuEscrowPolicy,
  CashuEscrowPolicyState,
  CashuMintConfig,
  GenericPaymentIdentity,
  GenericPaymentIntent,
  GenericPaymentRecoveryItem,
  GenericPaymentValidationRequest,
  GenericPaymentValidationResult,
  GenericAuctionSettlementIntent,
  CashuPaymentAmountLimits,
  GenericPolicyPaymentState,
} from '../types.js'
import {
  anyProofPending,
  cashuAuctionP2pkOptions,
  cashuAuctionPolicyHash,
  cashuAuctionPolicyType,
  cashuPromotionAuthorization,
  canonicalCashuAssetId,
  cashuEscrowP2pkOptions,
  cashuEscrowPolicyHash,
  cashuEscrowPolicyType,
  type CashuP2pkPolicyType,
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

export type CashuAuctionPolicyOptions = CashuEscrowPolicyOptions
export type CashuMarketplacePolicyOptions = CashuEscrowPolicyOptions

const defaultPollIntervalMs = 2_000
const defaultPaymentTimeoutMs = 20 * 60_000

type CashuPolicySubject = 'order' | 'bid'
type LimitReason = 'minting_disabled' | 'unsupported_method' | 'below_minimum' | 'above_maximum'

type CashuPolicyWatermarkContext = Parameters<CashuEscrowPolicy['discoverHighWatermark']>[0]
type CashuPolicyStartupContext = Parameters<CashuEscrowPolicy['startup']>[0]

type CashuPolicySpec<
  Id extends CashuP2pkPolicyType,
  Subject extends CashuPolicySubject,
  Family extends 'escrow' | 'auction',
> = {
  id: Id
  subject: Subject
  family: Family
  operationKind: 'cashu_escrow_mint' | 'cashu_auction_mint'
  operationPrefix: string
  noun: string
  policyHash(input: { mintUrl: string; unit: string; locktime?: number; participants?: CashuEscrowParticipants }): string
  p2pkOptions(input: CashuEscrowParticipants & { tradeId: string; settlementId: string; locktime: number }): ReturnType<typeof cashuEscrowP2pkOptions>
}

const cashuEscrowSpec: CashuPolicySpec<typeof cashuEscrowPolicyType, 'order', 'escrow'> = {
  id: cashuEscrowPolicyType,
  subject: 'order',
  family: 'escrow',
  operationKind: 'cashu_escrow_mint',
  operationPrefix: 'cashu-escrow',
  noun: 'escrow',
  policyHash: cashuEscrowPolicyHash,
  p2pkOptions: cashuEscrowP2pkOptions,
}

const cashuAuctionSpec: CashuPolicySpec<typeof cashuAuctionPolicyType, 'bid', 'auction'> = {
  id: cashuAuctionPolicyType,
  subject: 'bid',
  family: 'auction',
  operationKind: 'cashu_auction_mint',
  operationPrefix: 'cashu-auction',
  noun: 'auction bid',
  policyHash: cashuAuctionPolicyHash,
  p2pkOptions: cashuAuctionP2pkOptions,
}

function nowSeconds(now = Date.now): number {
  return Math.floor(now() / 1000)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class CashuPaymentAmountLimitError extends Error {
  readonly name = 'CashuPaymentAmountLimitError'
  readonly code = 'PAYMENT_AMOUNT_LIMIT'

  constructor(
    readonly reason: LimitReason,
    readonly limits: CashuPaymentAmountLimits,
  ) {
    super(formatCashuLimitMessage(reason, limits))
  }
}

function amountLimit(value: bigint, template: CashuAmount): CashuPaymentAmountLimits['min'] {
  return {
    value: value.toString(),
    denomination: template.denomination,
    decimals: template.decimals,
  }
}

function amountLikeToBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Cashu mint amount limit: ${value}`)
    return BigInt(value)
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw new Error(`Invalid Cashu mint amount limit: ${value}`)
    return BigInt(value)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.value !== undefined) return amountLikeToBigInt(record.value)
    if (record.amount !== undefined) return amountLikeToBigInt(record.amount)
    if (typeof value.toString === 'function') {
      const rendered = value.toString()
      if (/^\d+$/.test(rendered)) return BigInt(rendered)
    }
  }
  throw new Error('Invalid Cashu mint amount limit')
}

function formatCashuLimitMessage(reason: LimitReason, limits: CashuPaymentAmountLimits): string {
  if (reason === 'minting_disabled') {
    return `Cashu minting is disabled for ${limits.method} ${limits.unit} at ${limits.mintUrl}`
  }
  if (reason === 'unsupported_method') {
    return `Cashu mint ${limits.mintUrl} does not advertise ${limits.method} minting for ${limits.unit}`
  }
  if (reason === 'below_minimum') {
    return `Payment amount ${limits.amount.value} ${limits.amount.denomination} is below the Cashu mint minimum ${limits.min?.value} ${limits.amount.denomination}`
  }
  return `Payment amount ${limits.amount.value} ${limits.amount.denomination} is above the Cashu mint maximum ${limits.max?.value} ${limits.amount.denomination}`
}

function cashuMintLimits(wallet: Wallet, mint: CashuMintConfig, totalAmount: CashuAmount): CashuPaymentAmountLimits {
  const mintInfo = wallet.getMintInfo()
  const nut04 = mintInfo.isSupported(4)
  const limits: CashuPaymentAmountLimits = {
    source: 'cashu-mint',
    method: 'bolt11',
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    amount: {
      value: totalAmount.value.toString(),
      denomination: totalAmount.denomination,
      decimals: totalAmount.decimals,
    },
    min: null,
    max: mint.maxOrderAmount ? amountLimit(BigInt(mint.maxOrderAmount), totalAmount) : null,
  }
  if (nut04.disabled) throw new CashuPaymentAmountLimitError('minting_disabled', limits)
  const method = nut04.params.find(candidate =>
    candidate.method.toLowerCase() === 'bolt11' &&
    candidate.unit.toLowerCase() === mint.unit.toLowerCase())
  if (!method) throw new CashuPaymentAmountLimitError('unsupported_method', limits)
  const minAmount = amountLikeToBigInt(method.min_amount)
  const maxAmount = amountLikeToBigInt(method.max_amount)
  limits.min = minAmount === null ? null : amountLimit(minAmount, totalAmount)
  limits.max = maxAmount === null
    ? limits.max
    : !limits.max || maxAmount < BigInt(limits.max.value)
      ? amountLimit(maxAmount, totalAmount)
      : limits.max
  if (minAmount !== null && totalAmount.value < minAmount) throw new CashuPaymentAmountLimitError('below_minimum', limits)
  if (limits.max && totalAmount.value > BigInt(limits.max.value)) throw new CashuPaymentAmountLimitError('above_maximum', limits)
  return limits
}

function amount(input: { value: string; denomination: string; decimals: number }): CashuAmount {
  return {
    value: BigInt(input.value),
    denomination: input.denomination,
    decimals: input.decimals,
  }
}

function denomination(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : ''
}

function compatibleDenomination(expected: string | undefined, actual: unknown): boolean {
  if (!expected) return true
  const left = denomination(expected)
  const right = denomination(actual)
  if (left === right) return true
  return (left === 'BTC' && right === 'SAT') || (left === 'SAT' && right === 'BTC')
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

function resolveIntent(
  mints: CashuMintConfig[],
  intent: GenericPaymentIntent,
  spec: CashuPolicySpec<CashuP2pkPolicyType, CashuPolicySubject, 'escrow' | 'auction'>,
) {
  if (intent.method !== 'cashu') throw new Error(`Cashu ${spec.noun} policy cannot pay ${intent.method} intent`)
  if (intent.subject !== spec.subject) throw new Error(`Cashu ${spec.noun} policy cannot pay ${intent.subject} intents`)
  if (!intent.seed) throw new Error(`Cashu ${spec.noun} payment requires a marketplace seed`)
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
  const policyHash = mint.policyHash ?? spec.policyHash({ mintUrl: mint.mintUrl, unit: mint.unit })
  const conditionHash = spec.policyHash({
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    locktime,
    participants,
  })
  const targetOrder = targetOrderContext(intent.metadata?.targetOrder, intent.metadata?.targetListingAnchor)
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
    targetOrder,
  }
}

function targetOrderContext(value: unknown, fallbackListingAnchor?: unknown): Record<string, unknown> {
  const order = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const context: Record<string, unknown> = {}
  const listingAnchor = typeof order.listingAnchor === 'string' && order.listingAnchor.length > 0
    ? order.listingAnchor
    : typeof fallbackListingAnchor === 'string' && fallbackListingAnchor.length > 0
      ? fallbackListingAnchor
      : undefined
  if (listingAnchor) context.listingAnchor = listingAnchor
  for (const key of ['start', 'end', 'quantity', 'recipient'] as const) {
    if (order[key] !== undefined) context[key] = order[key]
  }
  return context
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

function createCashuPolicy<
  Id extends CashuP2pkPolicyType,
  Subject extends CashuPolicySubject,
  Family extends 'escrow' | 'auction',
>(
  options: CashuEscrowPolicyOptions,
  spec: CashuPolicySpec<Id, Subject, Family>,
): (Family extends 'auction' ? CashuAuctionPolicy : CashuEscrowPolicy) {
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
    id: spec.id,
    subject: spec.subject,
    family: spec.family,
    policies: () => options.mints.map(mint => ({
      method: 'cashu',
      id: canonicalCashuAssetId(mint.mintUrl, mint.unit),
      type: spec.id,
      hash: mint.policyHash ?? spec.policyHash({ mintUrl: mint.mintUrl, unit: mint.unit }),
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

    async discoverHighWatermark(context: CashuPolicyWatermarkContext) {
      return {
        policy: spec.id,
        maxUsedIndex: context.highWaterMark,
        nextUnusedIndex: context.highWaterMark + 1,
        scannedFrom: context.highWaterMark + 1,
        scannedThrough: context.highWaterMark,
        unusedWindow: context.unusedWindow,
        usedIndexes: [],
        recoveryActions: [],
      }
    },

    async startup(context: CashuPolicyStartupContext) {
      const activeOperations = await options.storage.list({
        status: ['quote_created', 'payment_required', 'minting'],
      })
      currentState = {
        enabled: options.mints.length > 0,
        started: true,
        mintCount: options.mints.length,
        startSummary: `${activeOperations.length} active Cashu ${spec.noun} operation(s) available for recovery`,
      }
      return {
        policy: spec.id,
        data: {
          mintCount: options.mints.length,
          activeOperations: activeOperations.length,
          highWaterMark: context.highWaterMark,
          nextUnusedIndex: context.nextUnusedIndex,
        },
      }
    },

    async *recover(payment: GenericPaymentRecoveryItem) {
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
      const resolved = resolveIntent(options.mints, intent, spec)
      const wallet = walletFactory(resolved.mint)
      await wallet.loadMint()
      const limits = cashuMintLimits(wallet, resolved.mint, resolved.totalAmount)
      const createdAt = nowSeconds(options.now)
      const operationId = `${spec.operationPrefix}-${intent.settlementId}-${intent.accountIndex}`
      const description = `Marketplace Cashu ${spec.noun} ${intent.settlementId}`
      const quote = await wallet.createMintQuoteBolt11(resolved.totalAmount.value, description)
      await options.storage.put({
        id: operationId,
        kind: spec.operationKind,
        status: 'payment_required',
        tradeId: intent.tradeId,
        settlementId: intent.settlementId,
        accountIndex: intent.accountIndex,
        mintUrl: resolved.mint.mintUrl,
        unit: resolved.mint.unit,
        quoteId: quote.quote,
        request: quote.request,
        data: {
          policyType: spec.id,
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
            policyType: spec.id,
            mint: resolved.mint.mintUrl,
            unit: resolved.mint.unit,
            quoteId: quote.quote,
            tradeIndex: intent.accountIndex,
            buyerCashuPubkey: resolved.participants.buyerPubkey,
            limits,
          },
        },
        proof: null,
        data: {
          method: 'cashu',
          policyType: spec.id,
          mint: resolved.mint.mintUrl,
          quoteId: quote.quote,
          tradeIndex: intent.accountIndex,
          limits,
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
        .asP2PK(spec.p2pkOptions({
          tradeId: intent.tradeId,
          settlementId: intent.settlementId,
          locktime: resolved.locktime,
          ...resolved.participants,
        }))
        .run()
      const proof = cashuPaymentProof({
        policyType: spec.id,
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
        ...(spec.id === cashuAuctionPolicyType
          ? {
              recycleArgs: cashuPromotionAuthorization({
                buyerPrivateKey: resolved.buyerKey.privateKey,
                buyerPubkey: resolved.buyerKey.publicKey,
                tradeId: intent.tradeId,
                settlementId: intent.settlementId,
                locktime: resolved.locktime,
                participants: resolved.participants,
                order: resolved.targetOrder,
              }),
            }
          : {}),
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
          policyType: spec.id,
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
        const policyType = request.proof.params.policyType
        if (policyType && policyType !== spec.id) {
          return {
            method: 'cashu',
            status: 'unverifiable',
            error: `Cashu ${spec.noun} policy cannot validate ${String(policyType)}`,
          }
        }
        const data = mintedProofsData(request.proof)
        const locktime = Number(request.proof.params.locktime)
        const expectedAmount =
          (request.expected.amount ? BigInt(request.expected.amount.value) : data.amount) +
          (request.expected.fee ? BigInt(request.expected.fee.value) : 0n)
        const proofs = proofsFromPaymentProof(request.proof)
        const amountMatched = proofAmount(proofs) >= expectedAmount
        const assetMatched =
          (!request.expected.asset?.assetId || request.expected.asset.assetId === canonicalCashuAssetId(data.mint, data.unit)) &&
          compatibleDenomination(request.expected.asset?.denomination, request.proof.params.denomination)
        const policyMatched = proofs.every(proof => proofPolicyMatches(proof, {
          tradeId: request.expected.tradeId ?? String(request.proof.params.tradeId ?? ''),
          settlementId: request.expected.settlementId,
          locktime,
          policyType: spec.id,
          ...data.participants,
        }))
        const wallet = walletFactory({ mintUrl: data.mint, unit: data.unit, denomination: '', decimals: 0 })
        await wallet.loadMint()
        const states = await proofStates(wallet, proofs)
        const unspent = everyProofUnspent(states)
        if (!amountMatched) return { method: 'cashu', status: 'invalid', amountMatched, assetMatched, escrowMatched: policyMatched, error: 'Cashu amount mismatch' }
        if (!assetMatched) return { method: 'cashu', status: 'invalid', amountMatched, assetMatched, escrowMatched: policyMatched, error: 'Cashu asset mismatch' }
        if (!policyMatched) return { method: 'cashu', status: 'invalid', amountMatched, assetMatched, escrowMatched: false, error: `Cashu ${spec.noun} policy mismatch` }
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

    async refundPayment(intent: GenericAuctionSettlementIntent & { action: 'auction_refund'; refundPercent: number }) {
      if (spec.family !== 'auction') throw new Error('Cashu escrow policy cannot refund auction bids')
      return {
        proof: {
          method: 'cashu',
          params: {
            ...intent.proof.params,
            action: 'auction_refund',
            refundPercent: intent.refundPercent,
            refunded: true,
          },
        },
        data: {
          method: 'cashu',
          policyType: spec.id,
          refundPercent: intent.refundPercent,
        },
      }
    },

    async recyclePayment(
      intent: GenericAuctionSettlementIntent & {
        action: 'auction_promote'
        targetTradeId: string
        targetOrderGroupId: string
      },
    ) {
      if (spec.family !== 'auction') throw new Error('Cashu escrow policy cannot recycle auction bids')
      if (intent.recycleArgs === undefined || intent.recycleArgs === null) {
        throw new Error('Cashu auction promotion requires recycleArgs')
      }
      return {
        proof: {
          method: 'cashu',
          params: {
            ...intent.proof.params,
            action: 'auction_promote',
            policyType: cashuEscrowPolicyType,
            subject: 'order',
            sourcePolicyType: intent.proof.params.policyType ?? cashuAuctionPolicyType,
            sourceSettlementId: intent.expected?.settlementId,
            sourceTradeId: intent.proof.params.tradeId,
            tradeId: intent.targetTradeId,
            settlementId: intent.targetOrderGroupId,
            ...(intent.targetUnlockAt !== undefined ? { locktime: intent.targetUnlockAt } : {}),
            recycleArgs: intent.recycleArgs,
            recycled: true,
          },
        },
        data: {
          method: 'cashu',
          fromPolicyType: cashuAuctionPolicyType,
          toPolicyType: cashuEscrowPolicyType,
          targetTradeId: intent.targetTradeId,
          targetOrderGroupId: intent.targetOrderGroupId,
        },
      }
    },

    state() {
      return currentState
    },
  } as unknown as Family extends 'auction' ? CashuAuctionPolicy : CashuEscrowPolicy
}

export function createCashuEscrowPolicy(options: CashuEscrowPolicyOptions): CashuEscrowPolicy {
  return createCashuPolicy(options, cashuEscrowSpec)
}

export function createCashuAuctionPolicy(options: CashuAuctionPolicyOptions): CashuAuctionPolicy {
  return createCashuPolicy(options, cashuAuctionSpec)
}
