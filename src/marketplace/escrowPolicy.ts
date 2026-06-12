import {
  MintQuoteState,
  Wallet,
  type MintQuoteBolt11Response,
  type Proof,
} from '@cashu/cashu-ts'
import {
  MarketplacePolicyBase,
  resolveMarketplaceDriverPaymentProofParams,
  type MarketplaceDriverLogger,
} from '@sudonym-btc/marketplace-driver-interface'

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
  GenericPaymentRecoveryState,
  GenericPaymentValidationRequest,
  GenericPaymentValidationResult,
  GenericAuctionSettlementIntent,
  CashuPaymentAmountLimits,
  CashuPaymentAsset,
  CashuPaymentPolicy,
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
  clearPaymentProofParams,
  deserializeCashuSwapPreview,
  everyProofUnspent,
  proofAmount,
  proofPolicyMatches,
  proofStates,
  proofsFromPaymentProof,
  proofsFromPaymentProofParams,
  serializeCashuSwapPreview,
  type CashuEscrowParticipants,
  type CashuRecycleArgs,
} from './proof.js'

export type CashuEscrowPolicyOptions = {
  mints: CashuMintConfig[]
  storage: CashuEscrowStorage
  appId?: string
  quotePollIntervalMs?: number
  quotePaymentTimeoutMs?: number
  walletFactory?: (mint: CashuMintConfig) => Wallet
  now?: () => number
  logger?: MarketplaceDriverLogger
}

export type CashuAuctionPolicyOptions = CashuEscrowPolicyOptions
export type CashuMarketplacePolicyOptions = CashuEscrowPolicyOptions

const defaultPollIntervalMs = 15_000
const defaultPaymentTimeoutMs = 20 * 60_000

function logCashu(
  logger: MarketplaceDriverLogger | undefined,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>,
  error?: unknown,
): void {
  const scoped = logger?.child?.({ scope: 'marketplace.cashu.pay' }) ?? logger
  void scoped?.[level](message, data, error)
}

type CashuPolicyPurpose = 'order' | 'bid'
type LimitReason = 'minting_disabled' | 'unsupported_method' | 'below_minimum' | 'above_maximum'

type CashuPolicyWatermarkContext = Parameters<CashuEscrowPolicy['discoverHighWatermark']>[0]
type CashuPolicyStartupContext = Parameters<CashuEscrowPolicy['startup']>[0]

type CashuPolicySpec<
  Id extends CashuP2pkPolicyType,
  Purpose extends CashuPolicyPurpose,
  Family extends 'escrow' | 'auction',
> = {
  id: Id
  purpose: Purpose
  family: Family
  operationKind: 'cashu_escrow_mint' | 'cashu_auction_mint'
  operationPrefix: string
  noun: string
  policyHash(input: { mintUrl: string; unit: string; locktime?: number; participants?: CashuEscrowParticipants }): string
  p2pkOptions(input: CashuEscrowParticipants & { tradeId: string; settlementId: string; locktime: number }): ReturnType<typeof cashuEscrowP2pkOptions>
}

const cashuEscrowSpec: CashuPolicySpec<typeof cashuEscrowPolicyType, 'order', 'escrow'> = {
  id: cashuEscrowPolicyType,
  purpose: 'order',
  family: 'escrow',
  operationKind: 'cashu_escrow_mint',
  operationPrefix: 'cashu-escrow',
  noun: 'escrow',
  policyHash: cashuEscrowPolicyHash,
  p2pkOptions: cashuEscrowP2pkOptions,
}

const cashuAuctionSpec: CashuPolicySpec<typeof cashuAuctionPolicyType, 'bid', 'auction'> = {
  id: cashuAuctionPolicyType,
  purpose: 'bid',
  family: 'auction',
  operationKind: 'cashu_auction_mint',
  operationPrefix: 'cashu-auction',
  noun: 'auction bid',
  policyHash: cashuAuctionPolicyHash,
  p2pkOptions: cashuAuctionP2pkOptions,
}

type CashuPolicyTarget = {
  policyType: CashuP2pkPolicyType
  policyHash: string
  conditionHash: string
  tradeId: string
  settlementId: string
  locktime: number
  participants: CashuEscrowParticipants
  p2pkOptions: ReturnType<typeof cashuEscrowP2pkOptions>
}

function cashuPolicyTarget(
  mint: CashuMintConfig,
  spec: CashuPolicySpec<CashuP2pkPolicyType, CashuPolicyPurpose, 'escrow' | 'auction'>,
  input: {
    tradeId: string
    settlementId: string
    locktime: number
    participants: CashuEscrowParticipants
  },
): CashuPolicyTarget {
  const policyHash = mint.policyHash ?? spec.policyHash({ mintUrl: mint.mintUrl, unit: mint.unit })
  const conditionHash = spec.policyHash({
    mintUrl: mint.mintUrl,
    unit: mint.unit,
    locktime: input.locktime,
    participants: input.participants,
  })
  return {
    policyType: spec.id,
    policyHash,
    conditionHash,
    tradeId: input.tradeId,
    settlementId: input.settlementId,
    locktime: input.locktime,
    participants: input.participants,
    p2pkOptions: spec.p2pkOptions({
      tradeId: input.tradeId,
      settlementId: input.settlementId,
      locktime: input.locktime,
      ...input.participants,
    }),
  }
}

function cashuEscrowRecycleTarget(
  mint: CashuMintConfig,
  input: {
    tradeId: string
    settlementId: string
    locktime: number
    participants: CashuEscrowParticipants
    order: Record<string, unknown>
  },
): CashuRecycleArgs['target'] {
  const target = cashuPolicyTarget(mint, cashuEscrowSpec, input)
  return {
    tradeId: target.tradeId,
    settlementId: target.settlementId,
    policyType: cashuEscrowPolicyType,
    policyHash: target.policyHash,
    conditionHash: target.conditionHash,
    locktime: target.locktime,
    participants: target.participants,
    p2pkOptions: target.p2pkOptions,
    ...(Object.keys(input.order).length > 0 ? { order: input.order } : {}),
  }
}

function nowSeconds(now = Date.now): number {
  return Math.floor(now() / 1000)
}

function abortSleepError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortSleepError())
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(abortSleepError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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

function currency(value: unknown): string {
  const normalized = denomination(value)
  if (normalized === 'SAT' || normalized === 'SATS' || normalized === 'XBT') return 'BTC'
  if (normalized === 'USDT' || normalized === 'USDC') return 'USD'
  return normalized
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
  spec: CashuPolicySpec<CashuP2pkPolicyType, CashuPolicyPurpose, 'escrow' | 'auction'>,
) {
  if (intent.method !== 'cashu') throw new Error(`Cashu ${spec.noun} policy cannot pay ${intent.method} intent`)
  if (intent.purpose !== spec.purpose) throw new Error(`Cashu ${spec.noun} policy cannot pay ${intent.purpose} intents`)
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
    arbiterPubkey: identityCashuPubkey(intent.participants.arbiter, 'arbiter'),
  }
  const locktime = intent.unlockAt
  const target = cashuPolicyTarget(mint, spec, {
    tradeId: intent.tradeId,
    settlementId: intent.settlementId,
    locktime,
    participants,
  })
  const targetOrder = targetOrderContext(intent.metadata?.targetOrder, intent.metadata?.targetListingAnchor)
  const recycleTargetTradeId = typeof intent.metadata?.targetTradeId === 'string' && intent.metadata.targetTradeId.length > 0
    ? intent.metadata.targetTradeId
    : intent.tradeId
  const recycleTargetSettlementId =
    typeof intent.metadata?.targetOrderGroupId === 'string' && intent.metadata.targetOrderGroupId.length > 0
      ? intent.metadata.targetOrderGroupId
      : typeof intent.metadata?.targetSettlementId === 'string' && intent.metadata.targetSettlementId.length > 0
        ? intent.metadata.targetSettlementId
        : `${intent.settlementId}:escrow`
  const recycleTarget = spec.id === cashuAuctionPolicyType
    ? cashuEscrowRecycleTarget(mint, {
        tradeId: recycleTargetTradeId,
        settlementId: recycleTargetSettlementId,
        locktime,
        participants,
        order: targetOrder,
      })
    : undefined
  return {
    mint,
    paymentAmount,
    escrowFee,
    totalAmount,
    buyerKey,
    participants,
    locktime,
    target,
    policyHash: target.policyHash,
    conditionHash: target.conditionHash,
    targetOrder,
    recycleTarget,
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

async function prepareCashuAuctionRecycleSwap(input: {
  wallet: Wallet
  amount: bigint
  proofs: Proof[]
  buyerPrivateKey: string
  target: CashuRecycleArgs['target']
}): Promise<CashuRecycleArgs['swap']> {
  const preview = await input.wallet.prepareSwapToSend(
    input.amount,
    input.proofs,
    { includeFees: false },
    {
      send: { type: 'p2pk', options: input.target.p2pkOptions },
      keep: input.wallet.defaultOutputType(),
    },
  )
  const outputs = [...(preview.keepOutputs ?? []), ...(preview.sendOutputs ?? [])]
  return serializeCashuSwapPreview({
    ...preview,
    inputs: input.wallet.signP2PKProofs(preview.inputs, input.buyerPrivateKey, outputs),
  })
}

type PaidQuoteWaitOptions = {
  pollIntervalMs: number
  timeoutMs: number
  logger?: MarketplaceDriverLogger
}

function paidMintQuote(quote: MintQuoteBolt11Response): boolean {
  return quote.state === MintQuoteState.PAID || quote.state === MintQuoteState.ISSUED
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function waitForPaidQuoteWebsocket(
  wallet: Wallet,
  quote: MintQuoteBolt11Response,
  options: PaidQuoteWaitOptions & { signal: AbortSignal },
): Promise<MintQuoteBolt11Response> {
  const eventOptions: { signal?: AbortSignal; timeoutMs?: number } = {
    timeoutMs: options.timeoutMs,
  }
  eventOptions.signal = options.signal
  try {
    logCashu(options.logger, 'debug', 'Waiting for Cashu mint quote payment over websocket', {
      quoteId: quote.quote,
      timeoutMs: options.timeoutMs,
    })
    const paidQuote = await wallet.on.onceMintPaid(quote.quote, eventOptions)
    if (paidMintQuote(paidQuote)) return paidQuote
    throw new Error(`Cashu websocket returned unpaid mint quote state: ${paidQuote.state}`)
  } catch (error) {
    if (!abortError(error)) {
      logCashu(options.logger, 'warn', 'Cashu mint quote websocket wait failed; continuing with slow polling', {
        quoteId: quote.quote,
      }, error)
    }
    throw error
  }
}

async function waitForPaidQuotePoll(
  wallet: Wallet,
  quote: MintQuoteBolt11Response,
  options: PaidQuoteWaitOptions & { initialDelayMs?: number; signal?: AbortSignal },
): Promise<MintQuoteBolt11Response> {
  const deadline = Date.now() + options.timeoutMs
  let latest = quote
  let lastError: unknown
  let loggedPollError = false
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 0)
  if (initialDelayMs > 0) await sleep(Math.min(initialDelayMs, remainingMs(deadline)), options.signal)
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw abortSleepError()
    try {
      latest = await wallet.checkMintQuoteBolt11(quote.quote)
      if (paidMintQuote(latest)) return latest
      lastError = undefined
    } catch (error) {
      lastError = error
      if (!loggedPollError) {
        loggedPollError = true
        logCashu(options.logger, 'warn', 'Cashu mint quote slow poll failed; will retry until timeout', {
          quoteId: quote.quote,
          pollIntervalMs: options.pollIntervalMs,
        }, error)
      }
    }
    const waitMs = Math.min(Math.max(0, options.pollIntervalMs), remainingMs(deadline))
    if (waitMs > 0) await sleep(waitMs, options.signal)
  }
  const lastErrorMessage = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for Cashu mint quote payment; last state: ${latest.state}${lastErrorMessage}`)
}

async function waitForPaidQuote(
  wallet: Wallet,
  quote: MintQuoteBolt11Response,
  options: PaidQuoteWaitOptions,
): Promise<MintQuoteBolt11Response> {
  if (paidMintQuote(quote)) return quote
  const websocketWaitAvailable = typeof wallet.on?.onceMintPaid === 'function'
  if (!websocketWaitAvailable) return waitForPaidQuotePoll(wallet, quote, options)

  const abortController = new AbortController()
  const websocketWait = waitForPaidQuoteWebsocket(wallet, quote, {
    ...options,
    signal: abortController.signal,
  })
  const pollWait = waitForPaidQuotePoll(wallet, quote, {
    ...options,
    initialDelayMs: options.pollIntervalMs,
    signal: abortController.signal,
  })
  try {
    return await Promise.any([websocketWait, pollWait])
  } catch (error) {
    if (error instanceof AggregateError) {
      const last = error.errors.at(-1)
      if (last instanceof Error) throw last
    }
    throw error
  } finally {
    abortController.abort()
  }
}

function mintedProofsData(params: Record<string, unknown>) {
  const mint = params.mint
  const unit = params.unit
  const amount = params.amount
  const paymentAmount = params.paymentAmount
  const escrowFee = params.escrowFee
  const participants = params.participants
  if (typeof mint !== 'string') throw new Error('Cashu proof missing mint')
  if (typeof unit !== 'string') throw new Error('Cashu proof missing unit')
  if (typeof amount !== 'string') throw new Error('Cashu proof missing amount')
  if (!participants || typeof participants !== 'object') throw new Error('Cashu proof missing participants')
  const fundedAmount = BigInt(amount)
  const fee = typeof escrowFee === 'string' ? BigInt(escrowFee) : 0n
  return {
    mint,
    unit,
    amount: fundedAmount,
    paymentAmount: typeof paymentAmount === 'string' ? BigInt(paymentAmount) : fundedAmount - fee,
    escrowFee: fee,
    participants: participants as CashuEscrowParticipants,
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`)
  return value
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`)
  return value
}

function recycleParticipants(value: unknown): CashuEscrowParticipants {
  const participants = recordValue(value, 'recycleArgs.target.participants')
  return {
    buyerPubkey: stringValue(participants.buyerPubkey, 'recycleArgs.target.participants.buyerPubkey'),
    sellerPubkey: stringValue(participants.sellerPubkey, 'recycleArgs.target.participants.sellerPubkey'),
    arbiterPubkey: stringValue(participants.arbiterPubkey, 'recycleArgs.target.participants.arbiterPubkey'),
  }
}

function cashuRecycleArgs(value: unknown): CashuRecycleArgs {
  const args = recordValue(value, 'recycleArgs')
  if (args.version !== 1 || args.type !== 'cashu:p2pk-auction-promote-v1') {
    throw new Error('Invalid Cashu auction recycleArgs type')
  }
  const source = recordValue(args.source, 'recycleArgs.source')
  const target = recordValue(args.target, 'recycleArgs.target')
  const swap = args.swap === undefined || args.swap === null
    ? undefined
    : recordValue(args.swap, 'recycleArgs.swap') as CashuRecycleArgs['swap']
  return {
    version: 1,
    type: 'cashu:p2pk-auction-promote-v1',
    fromPolicyType: cashuAuctionPolicyType,
    toPolicyType: cashuEscrowPolicyType,
    source: {
      tradeId: stringValue(source.tradeId, 'recycleArgs.source.tradeId'),
      settlementId: stringValue(source.settlementId, 'recycleArgs.source.settlementId'),
      policyType: cashuAuctionPolicyType,
    },
    message: stringValue(args.message, 'recycleArgs.message'),
    messageHash: stringValue(args.messageHash, 'recycleArgs.messageHash'),
    signerPubkey: stringValue(args.signerPubkey, 'recycleArgs.signerPubkey'),
    signature: stringValue(args.signature, 'recycleArgs.signature'),
    target: {
      tradeId: stringValue(target.tradeId, 'recycleArgs.target.tradeId'),
      settlementId: stringValue(target.settlementId, 'recycleArgs.target.settlementId'),
      policyType: cashuEscrowPolicyType,
      policyHash: stringValue(target.policyHash, 'recycleArgs.target.policyHash'),
      conditionHash: stringValue(target.conditionHash, 'recycleArgs.target.conditionHash'),
      locktime: numberValue(target.locktime, 'recycleArgs.target.locktime'),
      participants: recycleParticipants(target.participants),
      p2pkOptions: recordValue(target.p2pkOptions, 'recycleArgs.target.p2pkOptions') as CashuRecycleArgs['target']['p2pkOptions'],
      ...(target.order ? { order: recordValue(target.order, 'recycleArgs.target.order') } : {}),
    },
    ...(swap ? { swap } : {}),
  }
}

function cashuProofAmountTemplate(params: Record<string, unknown>, value: bigint): CashuAmount {
  return {
    value,
    denomination: typeof params.denomination === 'string' ? params.denomination : 'BTC',
    decimals: typeof params.decimals === 'number' ? params.decimals : 8,
  }
}

function createCashuPolicy<
  Id extends CashuP2pkPolicyType,
  Purpose extends CashuPolicyPurpose,
  Family extends 'escrow' | 'auction',
>(
  options: CashuEscrowPolicyOptions,
  spec: CashuPolicySpec<Id, Purpose, Family>,
): (Family extends 'auction' ? CashuAuctionPolicy : CashuEscrowPolicy) {
  const pollIntervalMs = options.quotePollIntervalMs ?? defaultPollIntervalMs
  const paymentTimeoutMs = options.quotePaymentTimeoutMs ?? defaultPaymentTimeoutMs
  const walletFactory = options.walletFactory ?? ((mint: CashuMintConfig) => new Wallet(mint.mintUrl, { unit: mint.unit }))

  class CashuPolicyImpl extends MarketplacePolicyBase<
    CashuEscrowPolicyState,
    GenericPolicyPaymentState,
    CashuPaymentPolicy,
    CashuPaymentAsset,
    GenericPaymentIntent,
    GenericPaymentValidationRequest,
    GenericPaymentValidationResult,
    GenericPaymentRecoveryItem,
    GenericPaymentRecoveryState,
    Purpose,
    Family
  > {
    declare readonly method: 'cashu'
    declare readonly id: Id
    declare readonly purpose: Purpose
    declare readonly family: Family

    constructor() {
      super({
        method: 'cashu',
        id: spec.id,
        purpose: spec.purpose,
        family: spec.family,
        initialState: {
          enabled: options.mints.length > 0,
          started: false,
          mintCount: options.mints.length,
          startSummary: 'Not started',
        },
        ...(options.logger ? { logger: options.logger } : {}),
      })
    }

    policies(): CashuPaymentPolicy[] {
      return options.mints.map(mint => ({
        method: 'cashu',
        id: canonicalCashuAssetId(mint.mintUrl, mint.unit),
        type: spec.id,
        hash: mint.policyHash ?? spec.policyHash({ mintUrl: mint.mintUrl, unit: mint.unit }),
        data: {
          mintUrl: mint.mintUrl,
          unit: mint.unit,
          ...(mint.data ?? {}),
        },
      })) as CashuPaymentPolicy[]
    }

    assets(): CashuPaymentAsset[] {
      return options.mints.map(mint => ({
        method: 'cashu',
        assetId: canonicalCashuAssetId(mint.mintUrl, mint.unit),
        currency: currency(mint.denomination),
        denomination: mint.denomination,
        decimals: mint.decimals,
        ...(options.appId ? { appId: options.appId } : {}),
        data: {
          mintUrl: mint.mintUrl,
          unit: mint.unit,
          ...(mint.data ?? {}),
        },
      }))
    }

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
    }

    async startup(context: CashuPolicyStartupContext) {
      const activeOperations = await options.storage.list({
        status: ['quote_created', 'payment_required', 'minting'],
      })
      this.setState({
        enabled: options.mints.length > 0,
        started: true,
        mintCount: options.mints.length,
        startSummary: `${activeOperations.length} active Cashu ${spec.noun} operation(s) available for recovery`,
      })
      this.log('info', 'Cashu policy startup complete', {
        policyType: spec.id,
        activeOperations: activeOperations.length,
        highWaterMark: context.highWaterMark,
        nextUnusedIndex: context.nextUnusedIndex,
      })
      return {
        policy: spec.id,
        data: {
          mintCount: options.mints.length,
          activeOperations: activeOperations.length,
          highWaterMark: context.highWaterMark,
          nextUnusedIndex: context.nextUnusedIndex,
        },
      }
    }

    async *recover(payment: GenericPaymentRecoveryItem) {
      if (payment.proof.driver !== 'cashu' && payment.proof.driver !== spec.id) {
        yield this.noOpRecoveryState({ reason: `Cashu policy cannot recover ${payment.proof.driver}` })
        return
      }
      try {
        const params = clearPaymentProofParams(payment.proof)
        const data = mintedProofsData(params)
        const wallet = walletFactory({ mintUrl: data.mint, unit: data.unit, denomination: '', decimals: 0 })
        await wallet.loadMint()
        const proofs = proofsFromPaymentProof(payment.proof)
        const states = await proofStates(wallet, proofs)
        if (everyProofUnspent(states)) {
          yield this.recoveredState({
            mint: data.mint,
            unit: data.unit,
            amount: data.amount.toString(),
            proofCount: proofs.length,
            states,
          })
          return
        }
        if (anyProofPending(states)) {
          yield this.progressRecoveryState('Cashu proofs are pending at the mint', {
            mint: data.mint,
            unit: data.unit,
            states,
          })
          return
        }
        yield this.noOpRecoveryState({ mint: data.mint, unit: data.unit, states })
      } catch (error) {
        yield this.noOpRecoveryState({
          reason: error instanceof Error ? error.message : 'Unable to recover Cashu payment',
        })
      }
    }

    async *pay(intent: GenericPaymentIntent): AsyncIterable<GenericPolicyPaymentState> {
      const resolved = resolveIntent(options.mints, intent, spec)
      const logger = intent.logger ?? options.logger
      logCashu(logger, 'info', 'Resolved Cashu payment intent', {
        policyType: spec.id,
        purpose: intent.purpose,
        tradeIndex: intent.accountIndex,
        settlementId: intent.settlementId,
        mint: resolved.mint.mintUrl,
        unit: resolved.mint.unit,
        amount: resolved.totalAmount.value.toString(),
      })
      const wallet = walletFactory(resolved.mint)
      await wallet.loadMint()
      const limits = cashuMintLimits(wallet, resolved.mint, resolved.totalAmount)
      const createdAt = nowSeconds(options.now)
      const operationId = `${spec.operationPrefix}-${intent.settlementId}-${intent.accountIndex}`
      const description = `Marketplace Cashu ${spec.noun} ${intent.settlementId}`
      const quote = await wallet.createMintQuoteBolt11(resolved.totalAmount.value, description)
      logCashu(logger, 'info', 'Created Cashu mint quote requiring Lightning payment', {
        policyType: spec.id,
        mint: resolved.mint.mintUrl,
        quoteId: quote.quote,
        tradeIndex: intent.accountIndex,
        limits,
      })
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
          arbiterCashuPubkey: resolved.participants.arbiterPubkey,
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
      logCashu(logger, 'info', 'Waiting for Cashu mint quote payment', {
        policyType: spec.id,
        mint: resolved.mint.mintUrl,
        quoteId: quote.quote,
        tradeIndex: intent.accountIndex,
      })

      const paidQuote = await waitForPaidQuote(wallet, quote, {
        pollIntervalMs,
        timeoutMs: paymentTimeoutMs,
        ...(logger ? { logger } : {}),
      })
      await options.storage.put({
        ...(await options.storage.get(operationId))!,
        status: 'minting',
        updatedAt: nowSeconds(options.now),
      })
      logCashu(logger, 'info', 'Cashu mint quote paid; minting escrow proofs', {
        policyType: spec.id,
        mint: resolved.mint.mintUrl,
        quoteId: paidQuote.quote,
        tradeIndex: intent.accountIndex,
      })
      yield {
        type: 'payment_progress',
        status: 'Mint quote paid; minting escrow proofs',
        data: { method: 'cashu', mint: resolved.mint.mintUrl, quoteId: paidQuote.quote },
      }

      const proofs = await wallet.ops
        .mintBolt11(resolved.totalAmount.value, paidQuote)
        .asP2PK(resolved.target.p2pkOptions)
        .run()
      const recycleSwap = resolved.recycleTarget
        ? await prepareCashuAuctionRecycleSwap({
            wallet,
            amount: resolved.totalAmount.value,
            proofs,
            buyerPrivateKey: resolved.buyerKey.privateKey,
            target: resolved.recycleTarget,
          })
        : undefined
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
                source: {
                  tradeId: intent.tradeId,
                  settlementId: intent.settlementId,
                  policyType: cashuAuctionPolicyType,
                },
                target: resolved.recycleTarget!,
                ...(recycleSwap ? { swap: recycleSwap } : {}),
              }),
            }
          : {}),
      })
      await options.storage.put({
        ...(await options.storage.get(operationId))!,
        status: 'completed',
        proofs: clearPaymentProofParams(proof).proofs as string[],
        updatedAt: nowSeconds(options.now),
      })
      logCashu(logger, 'info', 'Cashu escrow proofs minted', {
        policyType: spec.id,
        mint: resolved.mint.mintUrl,
        quoteId: paidQuote.quote,
        proofCount: proofs.length,
        amount: resolved.totalAmount.value.toString(),
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
    }

    async validatePayment(request: GenericPaymentValidationRequest): Promise<GenericPaymentValidationResult> {
      const methodResult = this.validateMethod(request)
      if (methodResult) return methodResult
      try {
        const policyTypeResult = this.validateProofPolicyType(request, spec.id, spec.noun)
        if (policyTypeResult) return policyTypeResult
        const params = await resolveMarketplaceDriverPaymentProofParams(request.proof, request.decryptParams)
        if (typeof params.policyType === 'string' && params.policyType !== spec.id) {
          return { driver: 'cashu', status: 'unverifiable', error: `Cashu ${spec.noun} policy cannot validate ${params.policyType}` }
        }
        const data = mintedProofsData(params)
        const locktime = Number(params.locktime)
        const expectedAmount = data.amount
        const proofs = proofsFromPaymentProofParams(params)
        const amountMatched = proofAmount(proofs) >= expectedAmount
        const configuredMint = options.mints.find(mint => mint.mintUrl === data.mint && mint.unit === data.unit)
        const assetMatched = Boolean(configuredMint && compatibleDenomination(configuredMint.denomination, params.denomination))
        const policyMatched = proofs.every(proof => proofPolicyMatches(proof, {
          tradeId: String(params.tradeId ?? ''),
          settlementId: String(params.settlementId ?? ''),
          locktime,
          policyType: spec.id,
          ...data.participants,
        }))
        const wallet = walletFactory({ mintUrl: data.mint, unit: data.unit, denomination: '', decimals: 0 })
        await wallet.loadMint()
        const states = await proofStates(wallet, proofs)
        const unspent = everyProofUnspent(states)
        if (!amountMatched) return { driver: 'cashu', status: 'invalid', amountMatched, assetMatched, arbiterMatched: policyMatched, error: 'Cashu amount mismatch' }
        if (!assetMatched) return { driver: 'cashu', status: 'invalid', amountMatched, assetMatched, arbiterMatched: policyMatched, error: 'Cashu asset mismatch' }
        if (!policyMatched) return { driver: 'cashu', status: 'invalid', amountMatched, assetMatched, arbiterMatched: false, error: `Cashu ${spec.noun} policy mismatch` }
        const status = unspent ? 'valid' : anyProofPending(states) ? 'pending' : 'invalid'
        const validationAmount = {
          value: data.paymentAmount.toString(),
          denomination: typeof params.denomination === 'string' ? params.denomination : data.unit,
          decimals: typeof params.decimals === 'number' ? params.decimals : 0,
        }
        return {
          driver: 'cashu',
          status,
          ...(status === 'valid'
            ? {
                amount: validationAmount,
                terms: {
                  ...(typeof params.settlementId === 'string' ? { settlementId: params.settlementId } : {}),
                  ...(typeof params.tradeId === 'string' ? { tradeId: params.tradeId } : {}),
                  paymentAmount: validationAmount,
                  fundedAmount: {
                    ...validationAmount,
                    value: data.amount.toString(),
                  },
                  escrowFee: {
                    ...validationAmount,
                    value: data.escrowFee.toString(),
                  },
                  ...(Number.isSafeInteger(locktime) ? { unlockAt: locktime } : {}),
                  asset: {
                    denomination: validationAmount.denomination,
                    decimals: validationAmount.decimals,
                    assetId: data.mint,
                  },
                  participants: {
                    buyer: { pubkey: data.participants.buyerPubkey },
                    seller: { pubkey: data.participants.sellerPubkey },
                    arbiter: { pubkey: data.participants.arbiterPubkey },
                  },
                  data: {
                    mint: data.mint,
                    unit: data.unit,
                  },
                },
              }
            : {}),
          amountMatched,
          assetMatched,
          recipientMatched: true,
          arbiterMatched: policyMatched,
          data: {
            mint: data.mint,
            unit: data.unit,
            proofCount: proofs.length,
            paymentAmount: data.paymentAmount.toString(),
            fundedAmount: data.amount.toString(),
            escrowFee: data.escrowFee.toString(),
            locktime,
            states,
          },
          ...(unspent ? {} : { error: 'Cashu proofs are not all unspent' }),
        }
      } catch (error) {
        return {
          driver: 'cashu',
          status: 'unverifiable',
          error: error instanceof Error ? error.message : 'Unable to validate Cashu payment',
        }
      }
    }

    async refundPayment(intent: GenericAuctionSettlementIntent & { action: 'auction_refund'; refundPercent: number }) {
      if (spec.family !== 'auction') throw new Error('Cashu escrow policy cannot refund auction bids')
      const sourceParams = clearPaymentProofParams(intent.proof)
      return {
        proof: {
          driver: 'cashu',
          params: {
            ...sourceParams,
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
    }

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
      if (!intent.seed) throw new Error('Cashu auction promotion requires the arbiter marketplace seed')
      const sourceParams = clearPaymentProofParams(intent.proof)
      const sourceData = mintedProofsData(sourceParams)
      const recycleArgs = cashuRecycleArgs(intent.recycleArgs)
      if (!recycleArgs.swap) throw new Error('Cashu auction promotion requires a prepared recycle swap')
      if (recycleArgs.source.tradeId !== String(sourceParams.tradeId ?? '')) {
        throw new Error('Cashu recycleArgs source trade does not match payment proof')
      }
      if (recycleArgs.source.settlementId !== String(sourceParams.settlementId ?? '')) {
        throw new Error('Cashu recycleArgs source settlement does not match payment proof')
      }
      if (recycleArgs.target.tradeId !== intent.targetTradeId) {
        throw new Error('Cashu recycleArgs target trade does not match promoted order')
      }
      if (recycleArgs.target.settlementId !== intent.targetOrderGroupId) {
        throw new Error('Cashu recycleArgs target settlement does not match promoted order group')
      }
      if (intent.targetUnlockAt !== undefined && recycleArgs.target.locktime !== intent.targetUnlockAt) {
        throw new Error('Cashu recycleArgs target locktime does not match settlement request')
      }
      const mint = options.mints.find(candidate =>
        candidate.mintUrl === sourceData.mint && candidate.unit === sourceData.unit
      ) ?? {
        mintUrl: sourceData.mint,
        unit: sourceData.unit,
        denomination: typeof sourceParams.denomination === 'string' ? sourceParams.denomination : sourceData.unit,
        decimals: typeof sourceParams.decimals === 'number' ? sourceParams.decimals : 0,
      }
      const arbiterKey = deriveCashuEscrowKey(intent.seed, {
        accountIndex: 0,
        mintUrl: sourceData.mint,
        unit: sourceData.unit,
        role: 'settlement',
      })
      if (arbiterKey.publicKey.toLowerCase() !== sourceData.participants.arbiterPubkey.toLowerCase()) {
        throw new Error('Cashu auction promotion requires the local arbiter Cashu key')
      }
      const wallet = walletFactory(mint)
      await wallet.loadMint()
      const swap = deserializeCashuSwapPreview(recycleArgs.swap)
      const completed = await wallet.completeSwap(swap, arbiterKey.privateKey)
      const recycledProofs = completed.send
      if (recycledProofs.length === 0) throw new Error('Cashu auction promotion produced no escrow proofs')
      const recycledAmount = proofAmount(recycledProofs)
      if (recycledAmount < sourceData.amount) {
        throw new Error('Cashu auction promotion produced less than the funded bid amount')
      }
      const recycledProof = cashuPaymentProof({
        policyType: cashuEscrowPolicyType,
        mintUrl: sourceData.mint,
        unit: sourceData.unit,
        amount: cashuProofAmountTemplate(sourceParams, sourceData.amount),
        escrowFee: cashuProofAmountTemplate(sourceParams, sourceData.escrowFee),
        tradeId: recycleArgs.target.tradeId,
        settlementId: recycleArgs.target.settlementId,
        quoteId: `recycle:${String(sourceParams.quoteId ?? recycleArgs.source.settlementId)}`,
        proofs: recycledProofs,
        participants: recycleArgs.target.participants,
        locktime: recycleArgs.target.locktime,
        policyHash: recycleArgs.target.policyHash,
        conditionHash: recycleArgs.target.conditionHash,
        recycleArgs,
      })
      return {
        proof: recycledProof,
        data: {
          method: 'cashu',
          fromPolicyType: cashuAuctionPolicyType,
          toPolicyType: cashuEscrowPolicyType,
          sourceSettlementId: intent.expected?.settlementId,
          sourceTradeId: sourceParams.tradeId,
          targetTradeId: intent.targetTradeId,
          targetOrderGroupId: intent.targetOrderGroupId,
          proofCount: recycledProofs.length,
        },
      }
    }
  }

  return new CashuPolicyImpl() as unknown as Family extends 'auction' ? CashuAuctionPolicy : CashuEscrowPolicy
}

export function createCashuEscrowPolicy(options: CashuEscrowPolicyOptions): CashuEscrowPolicy {
  return createCashuPolicy(options, cashuEscrowSpec)
}

export function createCashuAuctionPolicy(options: CashuAuctionPolicyOptions): CashuAuctionPolicy {
  return createCashuPolicy(options, cashuAuctionSpec)
}
