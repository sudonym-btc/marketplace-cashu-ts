import {
  Amount,
  CheckStateEnum,
  MintQuoteState,
  OutputData,
  SigAll,
  Wallet,
  blindMessage,
  getP2PKWitnessSignatures,
  type MintQuoteBolt11Response,
  type MintPreview,
  type OutputDataFactory,
  type Proof,
  type ProofLike,
} from '@cashu/cashu-ts'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  MarketplacePolicyBase,
  resolveMarketplaceDriverPaymentProofParams,
  type MarketplaceDriverConstructorOptions,
  type MarketplaceDriverLogger,
} from '@sudonym-btc/marketplace-driver-interface'

import { deriveCashuEscrowKey, maxCashuDerivationIndex } from '../seed.js'
import type { CashuEscrowOperation, CashuEscrowStorage } from '../storage.js'
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
  GenericPaymentSweepInput,
  GenericPaymentSweepState,
  GenericPaymentProof,
  GenericPaymentSettlementIntent,
  GenericPaymentSettlementState,
  GenericSwapResumeContext,
  GenericSwapResumeState,
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
  cashuRefundAuthorization,
  cashuRefundP2pkOptions,
  cashuRefundPolicyType,
  cashuRefundProof,
  canonicalCashuAssetId,
  cashuEscrowP2pkOptions,
  cashuEscrowPolicyHash,
  cashuEscrowPolicyType,
  cashuPaymentTerms,
  type CashuP2pkPolicyType,
  cashuPaymentProof,
  clearPaymentProofParams,
  deserializeCashuSwapPreview,
  everyProofUnspent,
  proofAmount,
  proofPolicyMatches,
  refundProofPolicyMatches,
  proofStates,
  proofsFromPaymentProof,
  proofsFromPaymentProofParams,
  serializeCashuSwapPreview,
  type CashuEscrowParticipants,
  type CashuRefundArgs,
  type CashuRecycleArgs,
} from './proof.js'

export type CashuEscrowPolicyOptions = MarketplaceDriverConstructorOptions & {
  mints: CashuMintConfig[]
  storage: CashuEscrowStorage
  quotePollIntervalMs?: number
  quotePaymentTimeoutMs?: number
  walletFactory?: (mint: CashuMintConfig) => Wallet
  now?: () => number
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
export type CashuPaymentAmountLimitReason =
  | 'minting_disabled'
  | 'unsupported_method'
  | 'below_minimum'
  | 'above_maximum'

type CashuPolicyWatermarkContext = Parameters<CashuEscrowPolicy['discoverHighWatermark']>[0]
type CashuPolicyStartupContext = Parameters<CashuEscrowPolicy['startup']>[0]

type CashuPolicySpec<
  Id extends CashuP2pkPolicyType,
  Purpose extends CashuPolicyPurpose,
  Family extends 'escrow' | 'auction',
> = {
  id: Id
  label: string
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
  label: 'Cashu escrow',
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
  label: 'Cashu auction',
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
    readonly reason: CashuPaymentAmountLimitReason,
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

function formatCashuLimitMessage(reason: CashuPaymentAmountLimitReason, limits: CashuPaymentAmountLimits): string {
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

function requireCashuMintCapabilities(wallet: Wallet, auction: boolean): void {
  const info = wallet.getMintInfo()
  if (!info.isSupported(11).supported) {
    throw new Error('Cashu escrow requires a mint that advertises NUT-11 spending-condition support')
  }
  if (auction && !info.isSupported(9).supported) {
    throw new Error('Cashu auction settlement requires a mint that advertises NUT-09 restore support')
  }
}

type CashuAuctionOutputKeyset = {
  id: string
  activeUntil: number
}

function requireCashuAuctionOutputKeyset(input: {
  wallet: Wallet
  mint: CashuMintConfig
  unit: string
  requiredThrough: number
  keysetId?: string
  expectedActiveUntil?: number
}): CashuAuctionOutputKeyset {
  if (!Number.isSafeInteger(input.requiredThrough) || input.requiredThrough < 0) {
    throw new Error('Cashu auction keyset horizon must be a non-negative Unix timestamp')
  }
  const keyset = input.wallet.getKeyset(input.keysetId)
  if (keyset.unit.toLowerCase() !== input.unit.toLowerCase()) {
    throw new Error(`Cashu auction output keyset ${keyset.id} does not use unit ${input.unit}`)
  }
  if (!keyset.isActive) {
    throw new Error(`Cashu auction output keyset ${keyset.id} is not active`)
  }
  const policies = (input.mint.auctionKeysetPolicies ?? [])
    .filter(policy => policy.keysetId === keyset.id)
  if (policies.length !== 1) {
    throw new Error(
      `Cashu auction output keyset ${keyset.id} requires one explicit operator active-until policy`,
    )
  }
  const activeUntil = policies[0]!.activeUntil
  if (!Number.isSafeInteger(activeUntil) || activeUntil < 0) {
    throw new Error(`Cashu auction output keyset ${keyset.id} has an invalid operator active-until policy`)
  }
  if (input.expectedActiveUntil !== undefined && activeUntil !== input.expectedActiveUntil) {
    throw new Error(`Cashu auction output keyset ${keyset.id} active-until policy changed`)
  }
  // NUT-02 final_expiry is a final redemption deadline, not an active-keyset
  // horizon. It may be null, but when present it must not undercut the operator
  // commitment used by the pre-authorized auction outputs.
  if (keyset.expiry !== undefined && keyset.expiry < activeUntil) {
    throw new Error(`Cashu auction output keyset ${keyset.id} expires before its active-until policy`)
  }
  if (activeUntil < input.requiredThrough) {
    throw new Error(
      `Cashu auction output keyset ${keyset.id} is not committed active through the settlement horizon`,
    )
  }
  return { id: keyset.id, activeUntil }
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

function currencyDecimals(denominationValue: unknown, decimals: number): number {
  const unit = denomination(denominationValue)
  return currency(unit) === 'BTC' && (unit === 'SAT' || unit === 'SATS')
    ? decimals + 8
    : decimals
}

function scaleExact(value: bigint, fromDecimals: number, toDecimals: number): bigint | undefined {
  if (fromDecimals === toDecimals) return value
  if (fromDecimals < toDecimals) return value * 10n ** BigInt(toDecimals - fromDecimals)
  const factor = 10n ** BigInt(fromDecimals - toDecimals)
  return value % factor === 0n ? value / factor : undefined
}

function expectedAmountMatches(
  actualValue: bigint,
  actualDenomination: string,
  actualDecimals: number,
  expected: { value: string; currency?: string; denomination: string; decimals: number },
): boolean {
  if (!/^\d+$/.test(expected.value)) return false
  const actualCurrency = currency(actualDenomination)
  const expectedCurrency = currency(expected.currency ?? expected.denomination)
  if (actualCurrency !== expectedCurrency) return false
  const scaled = scaleExact(
    actualValue,
    currencyDecimals(actualDenomination, actualDecimals),
    currencyDecimals(expected.denomination, expected.decimals),
  )
  return scaled === BigInt(expected.value)
}

function validateCashuExpectedEvidence(
  request: GenericPaymentValidationRequest,
  params: Record<string, unknown>,
  data: ReturnType<typeof mintedProofsData>,
): string | undefined {
  const expected = request.expected
  if (!expected) return undefined
  if (expected.settlementId && expected.settlementId !== params.settlementId) {
    return 'Cashu settlement id does not match expected payment'
  }
  if (expected.tradeId && expected.tradeId !== params.tradeId) {
    return 'Cashu trade id does not match expected payment'
  }
  const actualDenomination = typeof params.denomination === 'string' ? params.denomination : data.unit
  const actualDecimals = typeof params.decimals === 'number' ? params.decimals : 0
  if (expected.amount && !expectedAmountMatches(
    data.paymentAmount,
    actualDenomination,
    actualDecimals,
    expected.amount,
  )) {
    return 'Cashu payment amount does not match expected amount'
  }
  if (expected.fee && !expectedAmountMatches(
    data.escrowFee,
    actualDenomination,
    actualDecimals,
    expected.fee,
  )) {
    return 'Cashu escrow fee does not match expected fee'
  }
  if (expected.asset?.currency && currency(expected.asset.currency) !== currency(actualDenomination)) {
    return 'Cashu asset currency does not match expected asset'
  }
  if (expected.asset?.denomination &&
      currency(expected.asset.denomination) !== currency(actualDenomination)) {
    return 'Cashu asset denomination does not match expected asset'
  }
  if (expected.asset?.decimals !== undefined &&
      currencyDecimals(expected.asset.denomination ?? actualDenomination, expected.asset.decimals) !==
        currencyDecimals(actualDenomination, actualDecimals)) {
    return 'Cashu asset decimals do not match expected asset'
  }
  if (expected.asset?.assetId && expected.asset.assetId !== canonicalCashuAssetId(data.mint, data.unit)) {
    return 'Cashu asset id does not match expected asset'
  }
  return undefined
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
  feeReserve?: bigint
  proofs: Proof[]
  buyerPrivateKey: string
  target: CashuRecycleArgs['target']
  keysetId: string
}): Promise<CashuRecycleArgs['swap']> {
  const preview = await input.wallet.prepareSwapToSend(
    input.amount,
    input.proofs,
    { includeFees: false, keysetId: input.keysetId },
    {
      send: { type: 'p2pk', options: input.target.p2pkOptions },
      keep: input.wallet.defaultOutputType(),
    },
  )
  const actualFee = cashuAmountToBigInt(preview.fees)
  if (input.feeReserve !== undefined && actualFee !== input.feeReserve) {
    throw new Error(`Cashu auction recycle fee reserve mismatch: expected ${input.feeReserve.toString()}, got ${actualFee.toString()}`)
  }
  const outputs = [...(preview.keepOutputs ?? []), ...(preview.sendOutputs ?? [])]
  return serializeCashuSwapPreview({
    ...preview,
    inputs: input.wallet.signP2PKProofs(preview.inputs, input.buyerPrivateKey, outputs),
  })
}

async function prepareCashuAuctionRefundSwap(input: {
  wallet: Wallet
  amount: bigint
  feeReserve: bigint
  proofs: Proof[]
  buyerPrivateKey: string
  buyerPubkey: string
  tradeId: string
  settlementId: string
  keysetId: string
}): Promise<CashuSerializedRefundPreparation> {
  const p2pkOptions = cashuRefundP2pkOptions({
    buyerPubkey: input.buyerPubkey,
    tradeId: input.tradeId,
    settlementId: input.settlementId,
  })
  const preview = await input.wallet.prepareSwapToSend(
    input.amount,
    input.proofs,
    { includeFees: false, keysetId: input.keysetId },
    {
      send: { type: 'p2pk', options: p2pkOptions },
      keep: input.wallet.defaultOutputType(),
    },
  )
  const actualFee = cashuAmountToBigInt(preview.fees)
  if (actualFee !== input.feeReserve) {
    throw new Error(`Cashu auction refund fee reserve mismatch: expected ${input.feeReserve.toString()}, got ${actualFee.toString()}`)
  }
  const sourceValue = proofAmount(input.proofs)
  if (sourceValue !== input.amount + actualFee) {
    throw new Error('Cashu auction refund source value does not equal buyer output plus input fee')
  }
  if ((preview.keepOutputs?.length ?? 0) > 0 || (preview.unselectedProofs?.length ?? 0) > 0) {
    throw new Error('Cashu auction refund must not retain change or unselected source proofs')
  }
  const outputs = [...(preview.keepOutputs ?? []), ...(preview.sendOutputs ?? [])]
  return {
    swap: serializeCashuSwapPreview({
      ...preview,
      inputs: input.wallet.signP2PKProofs(preview.inputs, input.buyerPrivateKey, outputs),
    }),
    sourceValue,
    inputFee: actualFee,
    buyerOutputValue: input.amount,
  }
}

type CashuSerializedRefundPreparation = {
  swap: CashuRefundArgs['swap']
  sourceValue: bigint
  inputFee: bigint
  buyerOutputValue: bigint
}

function cashuAmountToBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  if (value && typeof value === 'object' && typeof (value as { toBigInt?: unknown }).toBigInt === 'function') {
    return (value as { toBigInt: () => bigint }).toBigInt()
  }
  return BigInt(String(value))
}

function keysetDenominations(wallet: Wallet, keysetId: string): bigint[] {
  return Object.keys(wallet.getKeyset(keysetId).keys)
    .map(value => BigInt(value))
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
}

function syntheticProofsForKeyset(wallet: Wallet, amount: bigint, keysetId: string): ProofLike[] {
  let remaining = amount
  const proofs: ProofLike[] = []
  for (const denomination of keysetDenominations(wallet, keysetId)) {
    if (denomination <= remaining) {
      proofs.push({
        id: keysetId,
        amount: denomination.toString(),
        secret: `synthetic:${keysetId}:${proofs.length}`,
        C: '',
      })
      remaining -= denomination
    }
    if (remaining === 0n) break
  }
  if (remaining !== 0n) throw new Error(`Cashu keyset cannot split amount ${amount.toString()}`)
  return proofs
}

async function cashuAuctionRecycleFunding(input: {
  wallet: Wallet
  amount: bigint
  target: CashuRecycleArgs['target']
  keysetId: string
}): Promise<{ fundingAmount: bigint; feeReserve: bigint }> {
  const keyset = input.wallet.getKeyset(input.keysetId)
  const maxReserve = cashuAmountToBigInt(
    input.wallet.getFeesForKeyset(Object.keys(keyset.keys).length, keyset.id),
  ) + 1n
  for (let feeReserve = 0n; feeReserve <= maxReserve; feeReserve += 1n) {
    const proofs = syntheticProofsForKeyset(input.wallet, input.amount + feeReserve, keyset.id)
    try {
      const preview = await input.wallet.prepareSwapToSend(
        input.amount,
        proofs,
        { includeFees: false, keysetId: keyset.id },
        {
          send: { type: 'p2pk', options: input.target.p2pkOptions },
          keep: input.wallet.defaultOutputType(),
        },
      )
      const actualFee = cashuAmountToBigInt(preview.fees)
      if (actualFee === feeReserve) {
        return { fundingAmount: input.amount + feeReserve, feeReserve }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('not enough funds')) throw error
    }
  }
  throw new Error(`Unable to calculate exact Cashu auction recycle fee reserve for amount ${input.amount.toString()}`)
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
    try {
      wallet.mint.disconnectWebSocket()
    } catch {
      // Quote state is already reconciled; socket cleanup must not change the result.
    }
  }
}

function mintedProofsData(params: Record<string, unknown>) {
  const mint = params.mint
  const unit = params.unit
  const amount = params.amount
  const paymentAmount = params.paymentAmount
  const settlementAmount = params.settlementAmount
  const fundingFee = params.fundingFee
  const escrowFee = params.escrowFee
  const participants = params.participants
  if (typeof mint !== 'string') throw new Error('Cashu proof missing mint')
  if (typeof unit !== 'string') throw new Error('Cashu proof missing unit')
  if (typeof amount !== 'string') throw new Error('Cashu proof missing amount')
  if (!participants || typeof participants !== 'object') throw new Error('Cashu proof missing participants')
  const fundedAmount = BigInt(amount)
  const fee = typeof escrowFee === 'string' ? BigInt(escrowFee) : 0n
  const providerFee = typeof fundingFee === 'string' ? BigInt(fundingFee) : 0n
  const settledAmount = typeof settlementAmount === 'string'
    ? BigInt(settlementAmount)
    : fundedAmount - providerFee
  const paidAmount = typeof paymentAmount === 'string' ? BigInt(paymentAmount) : settledAmount - fee
  if (fundedAmount < 0n || settledAmount < 0n || paidAmount < 0n || fee < 0n || providerFee < 0n) {
    throw new Error('Cashu proof contains a negative amount')
  }
  if (fundedAmount !== settledAmount + providerFee) {
    throw new Error('Cashu funded amount does not equal settlement amount plus funding fee')
  }
  if (settledAmount !== paidAmount + fee) {
    throw new Error('Cashu settlement amount does not equal payment amount plus escrow fee')
  }
  return {
    mint,
    unit,
    amount: fundedAmount,
    settlementAmount: settledAmount,
    paymentAmount: paidAmount,
    escrowFee: fee,
    fundingFee: providerFee,
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

function amountStringValue(value: unknown, label: string): string {
  const amount = stringValue(value, label)
  if (!/^(0|[1-9]\d*)$/.test(amount)) throw new Error(`Invalid ${label}`)
  return amount
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`)
  return value
}

function timestampValue(value: unknown, label: string): number {
  const timestamp = numberValue(value, label)
  if (timestamp < 0) throw new Error(`Invalid ${label}`)
  return timestamp
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
  if (args.fromPolicyType !== cashuAuctionPolicyType || args.toPolicyType !== cashuEscrowPolicyType) {
    throw new Error('Invalid Cashu auction recycleArgs policy transition')
  }
  const source = recordValue(args.source, 'recycleArgs.source')
  if (source.policyType !== cashuAuctionPolicyType) {
    throw new Error('Invalid Cashu auction recycleArgs source policy')
  }
  const target = recordValue(args.target, 'recycleArgs.target')
  if (target.policyType !== cashuEscrowPolicyType) {
    throw new Error('Invalid Cashu auction recycleArgs target policy')
  }
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
      mint: stringValue(source.mint, 'recycleArgs.source.mint'),
      unit: stringValue(source.unit, 'recycleArgs.source.unit'),
      outputKeysetId: stringValue(source.outputKeysetId, 'recycleArgs.source.outputKeysetId'),
      outputKeysetActiveUntil: timestampValue(
        source.outputKeysetActiveUntil,
        'recycleArgs.source.outputKeysetActiveUntil',
      ),
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

function verifyCashuRecycleAuthorization(args: CashuRecycleArgs, buyerPubkey: string): void {
  const normalizedBuyer = buyerPubkey.toLowerCase()
  if (args.signerPubkey.toLowerCase() !== normalizedBuyer) {
    throw new Error('Cashu recycle authorization signer is not the bid buyer')
  }
  const canonicalMessage = JSON.stringify({
    version: 1,
    type: 'cashu:p2pk-auction-promote-v1',
    fromPolicyType: cashuAuctionPolicyType,
    toPolicyType: cashuEscrowPolicyType,
    source: args.source,
    target: args.target,
    ...(args.swap ? { swap: args.swap } : {}),
  })
  if (args.message !== canonicalMessage) {
    throw new Error('Cashu recycle authorization message is not canonical')
  }
  const digest = sha256(new TextEncoder().encode(canonicalMessage))
  if (args.messageHash.toLowerCase() !== `0x${bytesToHex(digest)}`) {
    throw new Error('Cashu recycle authorization message hash mismatch')
  }
  const pubkey = hexToBytes(args.signerPubkey)
  const xOnlyPubkey = pubkey.length === 33 ? pubkey.slice(1) : pubkey
  if (!schnorr.verify(hexToBytes(args.signature), digest, xOnlyPubkey)) {
    throw new Error('Invalid Cashu recycle authorization signature')
  }
}

function cashuRefundArgs(value: unknown): CashuRefundArgs {
  const args = recordValue(value, 'refundArgs')
  if (args.version !== 1 || args.type !== 'cashu:p2pk-auction-refund-v1' || args.refundPercent !== 100) {
    throw new Error('Invalid Cashu auction refundArgs type or refund percentage')
  }
  const source = recordValue(args.source, 'refundArgs.source')
  if (source.policyType !== cashuAuctionPolicyType) {
    throw new Error('Invalid Cashu auction refundArgs source policy')
  }
  const target = recordValue(args.target, 'refundArgs.target')
  if (target.policyType !== cashuRefundPolicyType) {
    throw new Error('Invalid Cashu auction refundArgs target policy')
  }
  return {
    version: 1,
    type: 'cashu:p2pk-auction-refund-v1',
    refundPercent: 100,
    source: {
      tradeId: stringValue(source.tradeId, 'refundArgs.source.tradeId'),
      settlementId: stringValue(source.settlementId, 'refundArgs.source.settlementId'),
      policyType: cashuAuctionPolicyType,
      mint: stringValue(source.mint, 'refundArgs.source.mint'),
      unit: stringValue(source.unit, 'refundArgs.source.unit'),
      sourceValue: amountStringValue(source.sourceValue, 'refundArgs.source.sourceValue'),
      inputFee: amountStringValue(source.inputFee, 'refundArgs.source.inputFee'),
      keysetId: stringValue(source.keysetId, 'refundArgs.source.keysetId'),
      keysetActiveUntil: timestampValue(source.keysetActiveUntil, 'refundArgs.source.keysetActiveUntil'),
    },
    target: {
      policyType: cashuRefundPolicyType,
      buyerPubkey: stringValue(target.buyerPubkey, 'refundArgs.target.buyerPubkey'),
      buyerOutputValue: amountStringValue(target.buyerOutputValue, 'refundArgs.target.buyerOutputValue'),
    },
    message: stringValue(args.message, 'refundArgs.message'),
    messageHash: stringValue(args.messageHash, 'refundArgs.messageHash'),
    signerPubkey: stringValue(args.signerPubkey, 'refundArgs.signerPubkey'),
    signature: stringValue(args.signature, 'refundArgs.signature'),
    swap: recordValue(args.swap, 'refundArgs.swap') as CashuRefundArgs['swap'],
  }
}

function verifyCashuRefundAuthorization(args: CashuRefundArgs, buyerPubkey: string): void {
  const normalizedBuyer = buyerPubkey.toLowerCase()
  if (args.signerPubkey.toLowerCase() !== normalizedBuyer || args.target.buyerPubkey.toLowerCase() !== normalizedBuyer) {
    throw new Error('Cashu refund authorization signer and target must be the bid buyer')
  }
  const canonicalMessage = JSON.stringify({
    version: 1,
    type: 'cashu:p2pk-auction-refund-v1',
    refundPercent: 100,
    source: args.source,
    target: args.target,
    swap: args.swap,
  })
  if (args.message !== canonicalMessage) {
    throw new Error('Cashu refund authorization message is not canonical')
  }
  const digest = sha256(new TextEncoder().encode(canonicalMessage))
  if (args.messageHash.toLowerCase() !== `0x${bytesToHex(digest)}`) {
    throw new Error('Cashu refund authorization message hash mismatch')
  }
  const pubkey = hexToBytes(args.signerPubkey)
  const xOnlyPubkey = pubkey.length === 33 ? pubkey.slice(1) : pubkey
  if (!schnorr.verify(hexToBytes(args.signature), digest, xOnlyPubkey)) {
    throw new Error('Invalid Cashu refund authorization signature')
  }
}

function cashuProofIdentity(proof: ProofLike): string {
  return sortedJson({
    id: proof.id,
    amount: cashuAmountToBigInt(proof.amount).toString(),
    secret: proof.secret,
    C: proof.C,
  })
}

function sameCashuProofSet(left: ProofLike[], right: ProofLike[]): boolean {
  return left.length === right.length &&
    left.map(cashuProofIdentity).sort().join('\n') === right.map(cashuProofIdentity).sort().join('\n')
}

function validatedCashuRefundSwap(
  args: CashuRefundArgs,
  sourceParams: Record<string, unknown>,
  sourceData: ReturnType<typeof mintedProofsData>,
  sourceProofs: Proof[],
): ReturnType<typeof deserializeCashuSwapPreview> {
  verifyCashuRefundAuthorization(args, sourceData.participants.buyerPubkey)
  if (args.source.tradeId !== String(sourceParams.tradeId ?? '') ||
      args.source.settlementId !== String(sourceParams.settlementId ?? '')) {
    throw new Error('Cashu refund source ids do not match the payment proof')
  }
  if (args.source.mint !== sourceData.mint || args.source.unit !== sourceData.unit) {
    throw new Error('Cashu refund mint or unit does not match the payment proof')
  }
  if (BigInt(args.source.sourceValue) !== sourceData.amount ||
      BigInt(args.source.inputFee) !== sourceData.fundingFee ||
      BigInt(args.target.buyerOutputValue) !== sourceData.settlementAmount) {
    throw new Error('Cashu refund values do not match the funded payment')
  }
  if (sourceData.amount !== sourceData.settlementAmount + sourceData.fundingFee) {
    throw new Error('Cashu refund source value is not conserved')
  }
  const swap = deserializeCashuSwapPreview(args.swap)
  if (swap.keysetId !== args.source.keysetId) {
    throw new Error('Cashu refund output keyset does not match its authorization')
  }
  if (cashuAmountToBigInt(swap.amount) !== sourceData.settlementAmount ||
      cashuAmountToBigInt(swap.fees) !== sourceData.fundingFee) {
    throw new Error('Cashu refund swap amount or fee does not match its authorization')
  }
  if (!sameCashuProofSet(sourceProofs, swap.inputs)) {
    throw new Error('Cashu refund swap inputs do not match the payment proof')
  }
  if ((swap.keepOutputs?.length ?? 0) > 0 || (swap.unselectedProofs?.length ?? 0) > 0) {
    throw new Error('Cashu refund swap must not retain change or unselected proofs')
  }
  const sendOutputs = swap.sendOutputs ?? []
  if (sendOutputs.length === 0) throw new Error('Cashu refund swap has no buyer outputs')
  const sigAllOutputs = [...(swap.keepOutputs ?? []), ...sendOutputs]
    .map(output => output.blindedMessage)
  const currentDigest = SigAll.computeDigests(swap.inputs, sigAllOutputs).current
  const buyerPubkey = hexToBytes(sourceData.participants.buyerPubkey)
  const buyerXOnly = buyerPubkey.length === 33 ? buyerPubkey.slice(1) : buyerPubkey
  const buyerSignatures = getP2PKWitnessSignatures(swap.inputs[0]?.witness)
  if (!buyerSignatures.some(signature => schnorr.verify(
    hexToBytes(signature),
    hexToBytes(currentDigest),
    buyerXOnly,
  ))) {
    throw new Error('Cashu refund swap is missing the buyer SIG_ALL authorization')
  }
  const sendTotal = sendOutputs.reduce(
    (sum, output) => sum + cashuAmountToBigInt(output.blindedMessage.amount),
    0n,
  )
  if (sendTotal !== sourceData.settlementAmount) {
    throw new Error('Cashu refund buyer outputs do not equal the recoverable value')
  }
  if (sendOutputs.some(output => output.blindedMessage.id !== args.source.keysetId)) {
    throw new Error('Cashu refund output uses an unauthorized keyset')
  }
  if (!sendOutputs.every(output => refundProofPolicyMatches({
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
    secret: new TextDecoder().decode(output.secret),
    C: '',
  }, {
    buyerPubkey: sourceData.participants.buyerPubkey,
    tradeId: args.source.tradeId,
    settlementId: args.source.settlementId,
  }))) {
    throw new Error('Cashu refund output policy is not buyer-only and canonical')
  }
  return swap
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Hex(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)))
}

function cashuRequestFingerprint(input: {
  policyType: CashuP2pkPolicyType
  intent: GenericPaymentIntent
  resolved: ReturnType<typeof resolveIntent>
  fundingAmount: CashuAmount
  recycleFeeReserve?: bigint
  auctionOutputKeyset?: CashuAuctionOutputKeyset
}): string {
  return sha256Hex(sortedJson({
    version: 1,
    policyType: input.policyType,
    purpose: input.intent.purpose,
    tradeId: input.intent.tradeId,
    settlementId: input.intent.settlementId,
    accountIndex: input.intent.accountIndex,
    mintUrl: input.resolved.mint.mintUrl,
    unit: input.resolved.mint.unit,
    fundingAmount: input.fundingAmount.value.toString(),
    paymentAmount: input.resolved.paymentAmount.value.toString(),
    escrowFee: input.resolved.escrowFee.value.toString(),
    denomination: input.fundingAmount.denomination,
    decimals: input.fundingAmount.decimals,
    policyHash: input.resolved.policyHash,
    conditionHash: input.resolved.conditionHash,
    locktime: input.resolved.locktime,
    participants: input.resolved.participants,
    targetOrder: input.resolved.targetOrder,
    recycleTarget: input.resolved.recycleTarget,
    ...(input.recycleFeeReserve === undefined
      ? {}
      : { recycleFeeReserve: input.recycleFeeReserve.toString() }),
    ...(input.auctionOutputKeyset
      ? {
          auctionOutputKeysetId: input.auctionOutputKeyset.id,
          auctionOutputKeysetActiveUntil: input.auctionOutputKeyset.activeUntil,
        }
      : {}),
  }))
}

function deterministicCashuP2pkFactory(input: {
  seed: string
  requestFingerprint: string
  p2pkOptions: ReturnType<typeof cashuEscrowP2pkOptions>
}): OutputDataFactory {
  let outputIndex = 0
  return (value, keyset) => {
    const index = outputIndex
    outputIndex += 1
    const amountValue = Amount.from(value)
    // Let cashu-ts construct the canonical NUT-11 secret, then replace only
    // its random nonce and blinding factor with domain-separated derivations.
    // This makes the mint request replayable from the marketplace seed without
    // persisting bearer proofs or prepared output secrets.
    const template = OutputData.createSingleP2PKData(input.p2pkOptions, amountValue, keyset.id)
    const parsed = JSON.parse(new TextDecoder().decode(template.secret)) as [string, {
      nonce: string
      data: string
      tags?: string[][]
    }]
    const context = [
      'marketplace-cashu-mint-output-v1',
      input.seed.toLowerCase(),
      input.requestFingerprint,
      keyset.id,
      index.toString(),
      amountValue.toString(),
    ].join(':')
    parsed[1].nonce = sha256Hex(`${context}:nonce`)
    const secret = new TextEncoder().encode(JSON.stringify(parsed))
    const scalarDigest = sha256Hex(`${context}:blinding`)
    const blindingFactor = (BigInt(`0x${scalarDigest}`) % (secp256k1.Point.Fn.ORDER - 1n)) + 1n
    const blinded = blindMessage(secret, blindingFactor)
    return new OutputData({
      amount: amountValue,
      B_: blinded.B_.toHex(true),
      id: keyset.id,
    }, blinded.r, secret)
  }
}

async function restoreCashuOutputs(
  wallet: Wallet,
  outputs: MintPreview['outputData'],
  keysetId: string,
): Promise<Proof[]> {
  const restored = await wallet.mint.restore({ outputs: outputs.map(output => output.blindedMessage) })
  const signatures = new Map(restored.outputs.map((output, index) => [output.B_, restored.signatures[index]]))
  const keyset = wallet.getKeyset(keysetId)
  return outputs.map(output => {
    const signature = signatures.get(output.blindedMessage.B_)
    if (!signature) throw new Error('Cashu mint restore did not return every prepared output')
    const concrete = output instanceof OutputData
      ? output
      : OutputData.deserialize(OutputData.serialize(output))
    return concrete.toProof(signature, keyset)
  })
}

async function restorePreparedMint(wallet: Wallet, preview: MintPreview): Promise<Proof[]> {
  return restoreCashuOutputs(wallet, preview.outputData, preview.keysetId)
}

function validateCashuPaymentTerms(
  proof: GenericPaymentProof,
  params: Record<string, unknown>,
  policyType: CashuP2pkPolicyType,
): string | undefined {
  if (!proof.terms) return 'Cashu payment proof is missing public payment terms'
  const data = mintedProofsData(params)
  const denomination = typeof params.denomination === 'string' ? params.denomination : data.unit
  const decimals = typeof params.decimals === 'number' ? params.decimals : 0
  const recycleArgs = params.recycleArgs === undefined || params.recycleArgs === null
    ? undefined
    : cashuRecycleArgs(params.recycleArgs)
  const refundArgs = params.refundArgs === undefined || params.refundArgs === null
    ? undefined
    : cashuRefundArgs(params.refundArgs)
  if (refundArgs) {
    const sourceProofs = proofsFromPaymentProofParams(params)
    validatedCashuRefundSwap(refundArgs, params, data, sourceProofs)
  }
  const expectedTerms = cashuPaymentTerms({
    policyType,
    mintUrl: data.mint,
    unit: data.unit,
    amount: {
      value: data.amount,
      denomination,
      decimals,
    },
    paymentAmount: data.paymentAmount,
    settlementAmount: data.settlementAmount,
    escrowFee: data.escrowFee,
    denomination,
    decimals,
    tradeId: String(params.tradeId ?? ''),
    settlementId: String(params.settlementId ?? ''),
    participants: data.participants,
    locktime: Number(params.locktime),
    ...(recycleArgs ? { recycleArgs } : {}),
    ...(refundArgs ? { refundArgs } : {}),
  })
  if (sortedJson(proof.terms) !== sortedJson(expectedTerms)) {
    return 'Cashu payment public terms do not match proof evidence'
  }
  return undefined
}

function cashuProofAmountTemplate(params: Record<string, unknown>, value: bigint): CashuAmount {
  return {
    value,
    denomination: typeof params.denomination === 'string' ? params.denomination : 'BTC',
    decimals: typeof params.decimals === 'number' ? params.decimals : 8,
  }
}

function cashuPayoutInvoiceDescription(tradeId: string): string {
  return `Marketplace Payout ${tradeId}`
}

function cashuAmountToSats(amount: bigint, data: ReturnType<typeof mintedProofsData>, params: Record<string, unknown>): number {
  const unit = data.unit.trim().toLowerCase()
  const denomination = typeof params.denomination === 'string' ? params.denomination.trim().toUpperCase() : ''
  const decimals = typeof params.decimals === 'number' ? params.decimals : 0
  let sats: bigint
  if (unit === 'sat' || unit === 'sats') {
    sats = amount
  } else if (denomination === 'BTC' || denomination === 'TBTC' || denomination === 'XBT') {
    sats = (amount * 100_000_000n) / (10n ** BigInt(decimals))
  } else {
    throw new Error(`Cannot sweep Cashu ${data.unit} proofs to a BTC invoice`)
  }
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Cashu payout amount exceeds Number.MAX_SAFE_INTEGER')
  return Number(sats)
}

function cashuSweepAccountIndexes(payment: GenericPaymentSweepInput, maxScanIndex = 1_000): number[] {
  if (!Number.isSafeInteger(maxScanIndex) || maxScanIndex < 0 || maxScanIndex > maxCashuDerivationIndex) {
    throw new Error(`Invalid Cashu sweep max index: ${maxScanIndex}`)
  }
  const indexes = new Set<number>()
  if (payment.accountIndex !== undefined) {
    if (!Number.isSafeInteger(payment.accountIndex) || payment.accountIndex < 0 || payment.accountIndex > maxCashuDerivationIndex) {
      throw new Error(`Invalid Cashu sweep account index: ${payment.accountIndex}`)
    }
    indexes.add(payment.accountIndex)
  }
  for (let index = 0; index <= maxScanIndex; index += 1) indexes.add(index)
  return [...indexes]
}

function cashuSweepBuyerKey(payment: GenericPaymentSweepInput, data: ReturnType<typeof mintedProofsData>): {
  accountIndex: number
  privateKey: string
  publicKey: string
} | undefined {
  if (!payment.seed) return undefined
  const expectedPubkey = data.participants.buyerPubkey
  if (typeof expectedPubkey !== 'string' || expectedPubkey.length === 0) {
    throw new Error('Cashu proof missing buyer pubkey')
  }
  for (const accountIndex of cashuSweepAccountIndexes(payment)) {
    const key = deriveCashuEscrowKey(payment.seed, { accountIndex, role: 'buyer' })
    if (key.publicKey.toLowerCase() === expectedPubkey.toLowerCase()) {
      return { accountIndex, ...key }
    }
  }
  return undefined
}

function meltQuoteFeeReserve(quote: { fee_reserve?: unknown }): bigint {
  const reserve = quote.fee_reserve
  if (reserve === undefined || reserve === null) return 0n
  if (typeof reserve === 'bigint') return reserve
  if (typeof reserve === 'number') {
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw new Error(`Invalid Cashu melt fee reserve: ${reserve}`)
    return BigInt(reserve)
  }
  if (typeof reserve === 'string') return BigInt(reserve)
  if (typeof reserve === 'object') {
    if (typeof (reserve as { toBigInt?: unknown }).toBigInt === 'function') {
      return (reserve as { toBigInt: () => bigint }).toBigInt()
    }
    if ('amount' in reserve) return cashuAmountToBigInt(reserve.amount)
  }
  throw new Error('Invalid Cashu melt fee reserve')
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
    GenericPaymentSweepInput,
    GenericPaymentSweepState,
    GenericPaymentSettlementIntent,
    GenericPaymentSettlementState,
    GenericSwapResumeContext,
    GenericSwapResumeState,
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
        label: spec.label,
        proofSensitivity: 'secret',
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
      if (!Number.isSafeInteger(context.highWaterMark) ||
          context.highWaterMark < -1 ||
          context.highWaterMark >= maxCashuDerivationIndex) {
        throw new Error(`Cashu high-water mark must leave a valid uint32 index: ${context.highWaterMark}`)
      }
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
        status: ['quote_created', 'payment_required', 'minting', 'paid'],
      })
      const recoveryActions: Array<Record<string, unknown>> = []
      for (const operation of activeOperations) {
        if (!operation.quoteId || !operation.request || !operation.data?.requestFingerprint) {
          await options.storage.put({
            ...operation,
            status: 'reconciliation_required',
            error: 'Quote creation was interrupted before a recoverable quote was recorded',
            updatedAt: nowSeconds(options.now),
          })
          recoveryActions.push({
            operationId: operation.id,
            status: 'reconciliation_required',
          })
          continue
        }
        const mint = options.mints.find(candidate =>
          candidate.mintUrl === operation.mintUrl && candidate.unit === operation.unit)
        if (!mint) {
          recoveryActions.push({
            operationId: operation.id,
            status: 'configuration_required',
            mintUrl: operation.mintUrl,
            unit: operation.unit,
          })
          continue
        }
        try {
          const wallet = walletFactory(mint)
          await wallet.loadMint()
          const quote = await wallet.checkMintQuoteBolt11(operation.quoteId)
          const status = quote.state === MintQuoteState.UNPAID
            ? 'payment_required' as const
            : quote.state === MintQuoteState.PAID
              ? 'paid' as const
              : 'minting' as const
          const { error: _previousError, ...recoverableOperation } = operation
          await options.storage.put({
            ...recoverableOperation,
            status,
            request: quote.request || operation.request,
            data: {
              ...operation.data,
              quoteExpiry: quote.expiry,
            },
            updatedAt: nowSeconds(options.now),
          })
          recoveryActions.push({
            operationId: operation.id,
            quoteId: operation.quoteId,
            quoteState: quote.state,
            status,
          })
        } catch (error) {
          recoveryActions.push({
            operationId: operation.id,
            quoteId: operation.quoteId,
            status: 'retry_required',
            error: error instanceof Error ? error.message : 'Unable to check Cashu quote',
          })
        }
      }
      this.setState({
        enabled: options.mints.length > 0,
        started: true,
        mintCount: options.mints.length,
        startSummary: `${recoveryActions.length} Cashu ${spec.noun} recovery action(s) checked`,
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
          recoveryActions,
          highWaterMark: context.highWaterMark,
          nextUnusedIndex: context.nextUnusedIndex,
        },
      }
    }

    async *sweepPayment(payment: GenericPaymentSweepInput) {
      if (payment.proof.driver !== 'cashu' && payment.proof.driver !== spec.id) {
        yield this.noOpSweepState({ reason: `Cashu policy cannot sweep ${payment.proof.driver}` })
        return
      }
      try {
        const params = clearPaymentProofParams(payment.proof)
        const data = mintedProofsData(params)
        const wallet = walletFactory({ mintUrl: data.mint, unit: data.unit, denomination: '', decimals: 0 })
        await wallet.loadMint()
        requireCashuMintCapabilities(wallet, spec.family === 'auction')
        const proofs = proofsFromPaymentProof(payment.proof)
        const buyerKey = cashuSweepBuyerKey(payment, data)
        if (!buyerKey) {
          yield this.noOpSweepState({
            reason: 'Cashu sweep requires the local buyer Cashu key',
            mint: data.mint,
            unit: data.unit,
            expectedBuyerPubkey: data.participants.buyerPubkey,
          })
          return
        }
        const states = await proofStates(wallet, proofs)
        if (everyProofUnspent(states)) {
          if (!options.withdrawals) {
            yield this.noOpSweepState({
              reason: 'Cashu payout invoice provider is not configured',
              mint: data.mint,
              unit: data.unit,
              proofCount: proofs.length,
            })
            return
          }
          const tradeId = typeof params.tradeId === 'string' ? params.tradeId : payment.tradeId
          const proofTotal = proofAmount(proofs)
          const description = cashuPayoutInvoiceDescription(tradeId)
          let amountSats = cashuAmountToSats(proofTotal, data, params)
          let bolt11 = await options.withdrawals.createInvoice(amountSats, description)
          let quote = await wallet.createMeltQuoteBolt11(bolt11)
          let feeReserve = meltQuoteFeeReserve(quote)
          if (feeReserve > 0n) {
            const netAmount = proofTotal - feeReserve
            if (netAmount <= 0n) throw new Error('Cashu melt fee reserve exceeds proof amount')
            amountSats = cashuAmountToSats(netAmount, data, params)
            bolt11 = await options.withdrawals.createInvoice(amountSats, description)
            quote = await wallet.createMeltQuoteBolt11(bolt11)
            feeReserve = meltQuoteFeeReserve(quote)
          }
          yield this.progressSweepState('Created Cashu payout invoice', {
            mint: data.mint,
            unit: data.unit,
            amountSats,
            accountIndex: buyerKey.accountIndex,
            quoteId: quote.quote,
            feeReserve: feeReserve.toString(),
          })
          const melt = await wallet.meltProofsBolt11(quote, proofs, { privkey: buyerKey.privateKey })
          yield this.sweptState(payment.proof, {
            mint: data.mint,
            unit: data.unit,
            amount: proofTotal.toString(),
            amountSats,
            accountIndex: buyerKey.accountIndex,
            proofCount: proofs.length,
            quoteId: quote.quote,
            feeReserve: feeReserve.toString(),
            changeProofCount: melt.change?.length ?? 0,
            states,
          })
          return
        }
        if (anyProofPending(states)) {
          yield this.progressSweepState('Cashu proofs are pending at the mint', {
            mint: data.mint,
            unit: data.unit,
            states,
          })
          return
        }
        yield this.noOpSweepState({ mint: data.mint, unit: data.unit, states })
      } catch (error) {
        yield this.noOpSweepState({
          reason: error instanceof Error ? error.message : 'Unable to sweep Cashu payment',
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
      requireCashuMintCapabilities(wallet, spec.family === 'auction')
      const createdAt = nowSeconds(options.now)
      const operationId = `${spec.operationPrefix}-${intent.settlementId}-${intent.accountIndex}`
      const description = `Marketplace Cashu ${spec.noun} ${intent.settlementId}`
      const existingOperation = await options.storage.get(operationId)
      const auctionOutputKeyset = spec.family === 'auction'
        ? requireCashuAuctionOutputKeyset({
            wallet,
            mint: resolved.mint,
            unit: resolved.mint.unit,
            requiredThrough: resolved.locktime,
            ...(existingOperation?.data.mintKeysetId
              ? { keysetId: existingOperation.data.mintKeysetId }
              : {}),
            ...(existingOperation?.data.mintKeysetActiveUntil !== undefined
              ? { expectedActiveUntil: existingOperation.data.mintKeysetActiveUntil }
              : {}),
          })
        : undefined
      const recycleFunding = resolved.recycleTarget
        ? await cashuAuctionRecycleFunding({
            wallet,
            amount: resolved.totalAmount.value,
            target: resolved.recycleTarget,
            keysetId: auctionOutputKeyset!.id,
          })
        : undefined
      const mintAmount = recycleFunding?.fundingAmount ?? resolved.totalAmount.value
      const fundingAmount = { ...resolved.totalAmount, value: mintAmount }
      const limits = cashuMintLimits(wallet, resolved.mint, fundingAmount)
      const requestFingerprint = cashuRequestFingerprint({
        policyType: spec.id,
        intent,
        resolved,
        fundingAmount,
        ...(recycleFunding ? { recycleFeeReserve: recycleFunding.feeReserve } : {}),
        ...(auctionOutputKeyset ? { auctionOutputKeyset } : {}),
      })
      const initialOperation: CashuEscrowOperation = {
        id: operationId,
        kind: spec.operationKind,
        status: 'quote_created',
        tradeId: intent.tradeId,
        settlementId: intent.settlementId,
        accountIndex: intent.accountIndex,
        mintUrl: resolved.mint.mintUrl,
        unit: resolved.mint.unit,
        data: {
          version: 1,
          requestFingerprint,
          outputDerivationVersion: 1,
          policyType: spec.id,
          policyHash: resolved.policyHash,
          conditionHash: resolved.conditionHash,
          buyerCashuPubkey: resolved.participants.buyerPubkey,
          sellerCashuPubkey: resolved.participants.sellerPubkey,
          arbiterCashuPubkey: resolved.participants.arbiterPubkey,
          locktime: resolved.locktime,
          fundingAmount: fundingAmount.value.toString(),
          paymentAmount: resolved.paymentAmount.value.toString(),
          escrowFee: resolved.escrowFee.value.toString(),
          denomination: fundingAmount.denomination,
          decimals: fundingAmount.decimals,
          description,
          ...(auctionOutputKeyset
            ? {
                mintKeysetId: auctionOutputKeyset.id,
                mintKeysetActiveUntil: auctionOutputKeyset.activeUntil,
              }
            : {}),
          ...(recycleFunding ? { recycleFeeReserve: recycleFunding.feeReserve.toString() } : {}),
        },
        createdAt,
        updatedAt: createdAt,
      }
      let operation = existingOperation
      if (!operation) {
        if (options.storage.create) {
          const created = await options.storage.create(initialOperation)
          operation = created ? initialOperation : await options.storage.get(operationId)
        } else {
          // Custom durable stores should implement create() for cross-process
          // exclusion. The fallback remains safe for a single policy instance.
          await options.storage.put(initialOperation)
          operation = initialOperation
        }
      }
      if (!operation) throw new Error(`Unable to reserve Cashu operation ${operationId}`)
      if (operation.data.requestFingerprint !== requestFingerprint) {
        throw new Error(`Cashu operation id collision for ${operationId}`)
      }
      if (operation.status === 'completed') {
        throw new Error(`Cashu operation ${operationId} is already completed; reuse its published payment proof`)
      }
      if (operation.status === 'failed' || operation.status === 'reconciliation_required') {
        throw new Error(operation.error ?? `Cashu operation ${operationId} requires manual reconciliation`)
      }

      let quote: MintQuoteBolt11Response
      if (operation.quoteId && operation.request) {
        // Re-read the authoritative mint state before resuming. In particular,
        // PAID means it is safe to submit the deterministic outputs, whereas
        // ISSUED means those exact outputs must be restored instead.
        quote = await wallet.checkMintQuoteBolt11(operation.quoteId)
        if (quote.quote !== operation.quoteId) throw new Error('Cashu mint returned a mismatched quote id')
        if (!quote.request) quote = { ...quote, request: operation.request }
        operation = {
          ...operation,
          request: quote.request,
          data: {
            ...operation.data,
            quoteExpiry: quote.expiry,
          },
          updatedAt: nowSeconds(options.now),
        }
        await options.storage.put(operation)
        logCashu(logger, 'info', 'Resuming existing Cashu mint quote', {
          policyType: spec.id,
          mint: resolved.mint.mintUrl,
          quoteId: quote.quote,
          operationId,
        })
      } else if (operation.status === 'quote_created') {
        try {
          quote = await wallet.createMintQuoteBolt11(fundingAmount.value, description)
        } catch (error) {
          await options.storage.put({
            ...operation,
            status: 'reconciliation_required',
            error: 'Mint quote creation did not complete; refusing to create a replacement quote automatically',
            updatedAt: nowSeconds(options.now),
          })
          throw error
        }
        operation = {
          ...operation,
          status: 'payment_required',
          quoteId: quote.quote,
          request: quote.request,
          data: {
            ...operation.data,
            quoteExpiry: quote.expiry,
          },
          updatedAt: nowSeconds(options.now),
        }
        await options.storage.put(operation)
        logCashu(logger, 'info', 'Created Cashu mint quote requiring Lightning payment', {
          policyType: spec.id,
          mint: resolved.mint.mintUrl,
          quoteId: quote.quote,
          tradeIndex: intent.accountIndex,
          limits,
          amount: resolved.totalAmount.value.toString(),
          fundingAmount: fundingAmount.value.toString(),
          feeReserve: recycleFunding?.feeReserve.toString(),
        })
      } else {
        throw new Error(`Cashu operation ${operationId} has no recoverable quote`)
      }

      yield {
        type: 'payment_required',
        request: {
          type: 'bolt11',
          bolt11: quote.request,
          amount: {
            value: fundingAmount.value.toString(),
            denomination: fundingAmount.denomination,
            decimals: fundingAmount.decimals,
          },
          description,
          ...(quote.expiry !== null ? { expiresAt: quote.expiry } : {}),
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
          amount: resolved.totalAmount.value.toString(),
          fundingAmount: fundingAmount.value.toString(),
          feeReserve: recycleFunding?.feeReserve.toString(),
        },
      }

      yield {
        type: 'payment_progress',
        status: 'Waiting for Cashu mint quote payment',
        data: {
          method: 'cashu',
          stage: 'awaiting_external_payment',
          mint: resolved.mint.mintUrl,
          quoteId: quote.quote,
        },
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
      operation = {
        ...(await options.storage.get(operationId) ?? operation),
        status: 'paid',
        request: paidQuote.request || quote.request,
        data: {
          ...operation.data,
          quoteExpiry: paidQuote.expiry,
        },
        updatedAt: nowSeconds(options.now),
      }
      await options.storage.put(operation)
      logCashu(logger, 'info', 'Cashu mint quote paid; minting escrow proofs', {
        policyType: spec.id,
        mint: resolved.mint.mintUrl,
        quoteId: paidQuote.quote,
        tradeIndex: intent.accountIndex,
      })
      yield {
        type: 'payment_progress',
        status: 'Lightning payment detected; minting escrow proofs',
        data: {
          method: 'cashu',
          stage: 'external_payment_detected',
          mint: resolved.mint.mintUrl,
          quoteId: paidQuote.quote,
        },
      }

      // Quote payment can take long enough for mint metadata to change. Refresh
      // and re-check the exact precommitted output keyset before minting value.
      await wallet.loadMint(true)
      requireCashuMintCapabilities(wallet, spec.family === 'auction')
      if (auctionOutputKeyset) {
        requireCashuAuctionOutputKeyset({
          wallet,
          mint: resolved.mint,
          unit: resolved.mint.unit,
          requiredThrough: resolved.locktime,
          keysetId: auctionOutputKeyset.id,
          expectedActiveUntil: auctionOutputKeyset.activeUntil,
        })
      }
      let mintBuilder = wallet.ops
        .mintBolt11(fundingAmount.value, paidQuote)
        .asFactory(deterministicCashuP2pkFactory({
          seed: intent.seed!,
          requestFingerprint,
          p2pkOptions: resolved.target.p2pkOptions,
        }))
      if (operation.data.mintKeysetId) mintBuilder = mintBuilder.keyset(operation.data.mintKeysetId)
      const mintPreview = await mintBuilder.prepare()
      if (operation.data.mintKeysetId && operation.data.mintKeysetId !== mintPreview.keysetId) {
        throw new Error('Cashu mint keyset changed while resuming prepared outputs')
      }
      operation = {
        ...operation,
        status: 'minting',
        data: {
          ...operation.data,
          mintKeysetId: mintPreview.keysetId,
        },
        updatedAt: nowSeconds(options.now),
      }
      // The exact output derivation metadata is durable before the mint call.
      // The seed remains caller-owned and is never persisted by this driver.
      await options.storage.put(operation)
      const proofs = paidQuote.state === MintQuoteState.ISSUED
        ? await restorePreparedMint(wallet, mintPreview)
        : await wallet.completeMint(mintPreview)
      const recycleSwap = resolved.recycleTarget
        ? await prepareCashuAuctionRecycleSwap({
            wallet,
            amount: resolved.totalAmount.value,
            proofs,
            buyerPrivateKey: resolved.buyerKey.privateKey,
            target: resolved.recycleTarget,
            keysetId: auctionOutputKeyset!.id,
            ...(recycleFunding ? { feeReserve: recycleFunding.feeReserve } : {}),
          })
        : undefined
      const refundPreparation = spec.id === cashuAuctionPolicyType
        ? await prepareCashuAuctionRefundSwap({
            wallet,
            amount: resolved.totalAmount.value,
            feeReserve: recycleFunding!.feeReserve,
            proofs,
            buyerPrivateKey: resolved.buyerKey.privateKey,
            buyerPubkey: resolved.buyerKey.publicKey,
            tradeId: intent.tradeId,
            settlementId: intent.settlementId,
            keysetId: auctionOutputKeyset!.id,
          })
        : undefined
      const refundArgs = refundPreparation
        ? cashuRefundAuthorization({
            buyerPrivateKey: resolved.buyerKey.privateKey,
            buyerPubkey: resolved.buyerKey.publicKey,
            source: {
              tradeId: intent.tradeId,
              settlementId: intent.settlementId,
              policyType: cashuAuctionPolicyType,
              mint: resolved.mint.mintUrl,
              unit: resolved.mint.unit,
              sourceValue: refundPreparation.sourceValue.toString(),
              inputFee: refundPreparation.inputFee.toString(),
              keysetId: refundPreparation.swap.keysetId,
              keysetActiveUntil: auctionOutputKeyset!.activeUntil,
            },
            target: {
              policyType: cashuRefundPolicyType,
              buyerPubkey: resolved.buyerKey.publicKey,
              buyerOutputValue: refundPreparation.buyerOutputValue.toString(),
            },
            swap: refundPreparation.swap,
          })
        : undefined
      const proof = cashuPaymentProof({
        policyType: spec.id,
        mintUrl: resolved.mint.mintUrl,
        unit: resolved.mint.unit,
        amount: resolved.totalAmount,
        ...(recycleFunding
          ? {
              fundingFee: {
                ...resolved.totalAmount,
                value: recycleFunding.feeReserve,
              },
            }
          : {}),
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
                  mint: resolved.mint.mintUrl,
                  unit: resolved.mint.unit,
                  outputKeysetId: auctionOutputKeyset!.id,
                  outputKeysetActiveUntil: auctionOutputKeyset!.activeUntil,
                },
                target: resolved.recycleTarget!,
                ...(recycleSwap ? { swap: recycleSwap } : {}),
              }),
              refundArgs: refundArgs!,
            }
          : {}),
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
      // Advancing the generator after receiving `paid` acknowledges transfer
      // of the proof to the caller. Keep only a public idempotency tombstone.
      const completed = await options.storage.get(operationId)
      if (completed) {
        const { request: _request, error: _error, ...publicRecord } = completed
        await options.storage.put({
          ...publicRecord,
          status: 'completed',
          updatedAt: nowSeconds(options.now),
        })
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
        const termsError = validateCashuPaymentTerms(request.proof, params, spec.id)
        if (termsError) return { driver: 'cashu', status: 'invalid', error: termsError }
        const data = mintedProofsData(params)
        const expectedError = validateCashuExpectedEvidence(request, params, data)
        if (expectedError) return { driver: 'cashu', status: 'invalid', amountMatched: false, error: expectedError }
        const locktime = Number(params.locktime)
        const expectedAmount = data.amount
        const proofs = proofsFromPaymentProofParams(params)
        const amountMatched = proofAmount(proofs) === expectedAmount
        const proofsUnique = proofs.length > 0 &&
          new Set(proofs.map(proof => proof.secret)).size === proofs.length &&
          new Set(proofs.map(proof => proof.C)).size === proofs.length
        const configuredMint = options.mints.find(mint => mint.mintUrl === data.mint && mint.unit === data.unit)
        const assetMatched = Boolean(configuredMint && compatibleDenomination(configuredMint.denomination, params.denomination))
        const policyMatched = proofsUnique && proofs.every(proof => proofPolicyMatches(proof, {
          tradeId: String(params.tradeId ?? ''),
          settlementId: String(params.settlementId ?? ''),
          locktime,
          policyType: spec.id,
          ...data.participants,
        }))
        if (!amountMatched) return { driver: 'cashu', status: 'invalid', amountMatched, assetMatched, arbiterMatched: policyMatched, error: 'Cashu amount mismatch' }
        if (!assetMatched || !configuredMint) return { driver: 'cashu', status: 'invalid', amountMatched, assetMatched, arbiterMatched: policyMatched, error: 'Cashu asset mismatch' }
        if (!policyMatched) return { driver: 'cashu', status: 'invalid', amountMatched, assetMatched, arbiterMatched: false, error: `Cashu ${spec.noun} policy mismatch` }
        const wallet = walletFactory({ mintUrl: data.mint, unit: data.unit, denomination: '', decimals: 0 })
        await wallet.loadMint()
        requireCashuMintCapabilities(wallet, spec.family === 'auction')
        if (spec.family === 'auction') {
          if (!Number.isSafeInteger(locktime) || locktime < 0) {
            throw new Error('Cashu auction proof has an invalid locktime')
          }
          const refundArgs = cashuRefundArgs(params.refundArgs)
          const recycleArgs = cashuRecycleArgs(params.recycleArgs)
          const recycleSwap = recycleArgs.swap ? deserializeCashuSwapPreview(recycleArgs.swap) : undefined
          if (recycleArgs.source.mint !== data.mint || recycleArgs.source.unit !== data.unit) {
            throw new Error('Cashu auction recycle mint or unit does not match the payment proof')
          }
          if (!recycleSwap || recycleSwap.keysetId !== refundArgs.source.keysetId ||
              recycleArgs.source.outputKeysetId !== refundArgs.source.keysetId ||
              recycleArgs.source.outputKeysetActiveUntil !== refundArgs.source.keysetActiveUntil) {
            throw new Error('Cashu auction authorization keyset commitments do not match')
          }
          requireCashuAuctionOutputKeyset({
            wallet,
            mint: configuredMint,
            unit: data.unit,
            requiredThrough: Math.max(locktime, nowSeconds(options.now)),
            keysetId: refundArgs.source.keysetId,
            expectedActiveUntil: refundArgs.source.keysetActiveUntil,
          })
        }
        const states = await proofStates(wallet, proofs)
        const unspent = everyProofUnspent(states)
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
            settlementAmount: data.settlementAmount.toString(),
            escrowFee: data.escrowFee.toString(),
            fundingFee: data.fundingFee.toString(),
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
      if (intent.refundPercent !== 100) {
        throw new Error('Cashu auction refunds require refundPercent=100')
      }
      if (!intent.operationId) throw new Error('Cashu auction refund requires an operation id')
      if (!intent.seed) throw new Error('Cashu auction refund requires the arbiter marketplace seed')
      const sourceParams = clearPaymentProofParams(intent.proof)
      const sourceData = mintedProofsData(sourceParams)
      const rawRefundArgs = sourceParams.refundArgs
      if (rawRefundArgs === undefined || rawRefundArgs === null) {
        throw new Error('Cashu auction refund requires pre-authorized refundArgs')
      }
      const refundArgs = cashuRefundArgs(rawRefundArgs)
      const sourceProofs = proofsFromPaymentProofParams(sourceParams)
      if (proofAmount(sourceProofs) !== sourceData.amount) {
        throw new Error('Cashu auction refund source proofs do not exactly match the funded amount')
      }
      const sourceLocktime = Number(sourceParams.locktime)
      if (!Number.isSafeInteger(sourceLocktime)) throw new Error('Cashu auction proof has an invalid locktime')
      if (!sourceProofs.every(proof => proofPolicyMatches(proof, {
        tradeId: refundArgs.source.tradeId,
        settlementId: refundArgs.source.settlementId,
        locktime: sourceLocktime,
        policyType: cashuAuctionPolicyType,
        ...sourceData.participants,
      }))) {
        throw new Error('Cashu auction refund source proof policy mismatch')
      }
      // Validate the complete buyer-signed packet before loading or calling a
      // mint. This prevents a malicious target, fee, keyset, or input set from
      // reaching the financial side effect.
      const swap = validatedCashuRefundSwap(refundArgs, sourceParams, sourceData, sourceProofs)
      const mint = options.mints.find(candidate =>
        candidate.mintUrl === sourceData.mint && candidate.unit === sourceData.unit)
      if (!mint) throw new Error('Cashu auction refund mint is not configured')
      const arbiterKey = deriveCashuEscrowKey(intent.seed, {
        accountIndex: 0,
        role: 'settlement',
      })
      if (arbiterKey.publicKey.toLowerCase() !== sourceData.participants.arbiterPubkey.toLowerCase()) {
        throw new Error('Cashu auction refund requires the local arbiter Cashu key')
      }
      const wallet = walletFactory(mint)
      await wallet.loadMint(true)
      requireCashuMintCapabilities(wallet, true)
      requireCashuAuctionOutputKeyset({
        wallet,
        mint,
        unit: sourceData.unit,
        requiredThrough: Math.max(sourceLocktime, nowSeconds(options.now)),
        keysetId: refundArgs.source.keysetId,
        expectedActiveUntil: refundArgs.source.keysetActiveUntil,
      })
      const sendOutputs = swap.sendOutputs ?? []
      const inputStates = await proofStates(wallet, swap.inputs)
      let refundedProofs: Proof[]
      if (everyProofUnspent(inputStates)) {
        const completed = await wallet.completeSwap(swap, arbiterKey.privateKey)
        if ((completed.keep?.length ?? 0) > 0) {
          throw new Error('Cashu auction refund unexpectedly returned non-buyer change')
        }
        refundedProofs = completed.send
      } else if (inputStates.length > 0 && inputStates.every(state => state.state === CheckStateEnum.SPENT)) {
        refundedProofs = await restoreCashuOutputs(wallet, sendOutputs, swap.keysetId)
      } else if (anyProofPending(inputStates)) {
        throw new Error('Cashu auction refund is pending at the mint; retry with the same operation id')
      } else {
        throw new Error('Cashu auction refund source proofs have inconsistent spend states')
      }
      const buyerOutputValue = BigInt(refundArgs.target.buyerOutputValue)
      if (refundedProofs.length === 0 || proofAmount(refundedProofs) !== buyerOutputValue) {
        throw new Error('Cashu auction refund did not return the exact recoverable value')
      }
      if (!refundedProofs.every(proof => refundProofPolicyMatches(proof, {
        buyerPubkey: sourceData.participants.buyerPubkey,
        tradeId: refundArgs.source.tradeId,
        settlementId: refundArgs.source.settlementId,
      }))) {
        throw new Error('Cashu auction refund output policy mismatch')
      }
      const refundProof = cashuRefundProof({
        mintUrl: sourceData.mint,
        unit: sourceData.unit,
        amount: cashuProofAmountTemplate(sourceParams, buyerOutputValue),
        tradeId: refundArgs.source.tradeId,
        settlementId: refundArgs.source.settlementId,
        operationId: intent.operationId,
        buyerPubkey: sourceData.participants.buyerPubkey,
        sourceMessageHash: refundArgs.messageHash,
        proofs: refundedProofs,
      })
      const externalId = sha256Hex(sortedJson({
        mint: sourceData.mint,
        sourceMessageHash: refundArgs.messageHash,
        proofCommitments: refundedProofs.map(proof => proof.C),
      }))
      return {
        proof: refundProof,
        receipt: {
          status: 'completed',
          operationId: intent.operationId,
          externalId,
          evidence: {
            mint: sourceData.mint,
            unit: sourceData.unit,
            refundPercent: 100,
            sourceValue: sourceData.amount.toString(),
            inputFee: sourceData.fundingFee.toString(),
            buyerOutputValue: buyerOutputValue.toString(),
            sourceMessageHash: refundArgs.messageHash,
          },
        },
        inputs: [{
          sourceMessageHash: refundArgs.messageHash,
          sourceValue: sourceData.amount.toString(),
        }],
        outputs: [{
          policyType: cashuRefundPolicyType,
          buyerPubkey: sourceData.participants.buyerPubkey,
          amount: buyerOutputValue.toString(),
        }],
        data: {
          method: 'cashu',
          policyType: cashuRefundPolicyType,
          refundPercent: 100,
          sourceValue: sourceData.amount.toString(),
          inputFee: sourceData.fundingFee.toString(),
          buyerOutputValue: buyerOutputValue.toString(),
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
      verifyCashuRecycleAuthorization(recycleArgs, sourceData.participants.buyerPubkey)
      if (recycleArgs.source.tradeId !== String(sourceParams.tradeId ?? '')) {
        throw new Error('Cashu recycleArgs source trade does not match payment proof')
      }
      if (recycleArgs.source.settlementId !== String(sourceParams.settlementId ?? '')) {
        throw new Error('Cashu recycleArgs source settlement does not match payment proof')
      }
      if (recycleArgs.source.mint !== sourceData.mint || recycleArgs.source.unit !== sourceData.unit) {
        throw new Error('Cashu recycleArgs mint or unit does not match payment proof')
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
      const sourceLocktime = Number(sourceParams.locktime)
      if (!Number.isSafeInteger(sourceLocktime)) throw new Error('Cashu auction proof has an invalid locktime')
      const sourceProofs = proofsFromPaymentProofParams(sourceParams)
      if (proofAmount(sourceProofs) !== sourceData.amount) {
        throw new Error('Cashu auction source proofs do not exactly match the funded amount')
      }
      if (!sourceProofs.every(proof => proofPolicyMatches(proof, {
        tradeId: recycleArgs.source.tradeId,
        settlementId: recycleArgs.source.settlementId,
        locktime: sourceLocktime,
        policyType: cashuAuctionPolicyType,
        ...sourceData.participants,
      }))) {
        throw new Error('Cashu auction source proof policy mismatch')
      }
      const mint = options.mints.find(candidate =>
        candidate.mintUrl === sourceData.mint && candidate.unit === sourceData.unit
      )
      if (!mint) throw new Error('Cashu auction promotion mint is not configured')
      const arbiterKey = deriveCashuEscrowKey(intent.seed, {
        accountIndex: 0,
        role: 'settlement',
      })
      if (arbiterKey.publicKey.toLowerCase() !== sourceData.participants.arbiterPubkey.toLowerCase()) {
        throw new Error('Cashu auction promotion requires the local arbiter Cashu key')
      }
      const wallet = walletFactory(mint)
      await wallet.loadMint(true)
      requireCashuMintCapabilities(wallet, true)
      const swap = deserializeCashuSwapPreview(recycleArgs.swap)
      if (swap.keysetId !== recycleArgs.source.outputKeysetId) {
        throw new Error('Cashu auction recycle output keyset does not match its authorization')
      }
      requireCashuAuctionOutputKeyset({
        wallet,
        mint,
        unit: sourceData.unit,
        requiredThrough: Math.max(sourceLocktime, nowSeconds(options.now)),
        keysetId: recycleArgs.source.outputKeysetId,
        expectedActiveUntil: recycleArgs.source.outputKeysetActiveUntil,
      })
      if (!sameCashuProofSet(sourceProofs, swap.inputs)) {
        throw new Error('Cashu auction recycle inputs do not match the payment proof')
      }
      const sendOutputs = swap.sendOutputs ?? []
      if (sendOutputs.length === 0) throw new Error('Cashu auction recycle swap has no target outputs')
      const inputStates = await proofStates(wallet, swap.inputs)
      let recycledProofs: Proof[]
      if (everyProofUnspent(inputStates)) {
        const completed = await wallet.completeSwap(swap, arbiterKey.privateKey)
        recycledProofs = completed.send
      } else if (inputStates.length > 0 && inputStates.every(state => state.state === CheckStateEnum.SPENT)) {
        // A prior attempt consumed the inputs but lost its response. NUT-09
        // restores the exact outputs committed by the buyer's SIG_ALL witness.
        recycledProofs = await restoreCashuOutputs(wallet, sendOutputs, swap.keysetId)
      } else if (anyProofPending(inputStates)) {
        throw new Error('Cashu auction promotion is pending at the mint; retry with the same operation id')
      } else {
        throw new Error('Cashu auction source proofs have inconsistent spend states')
      }
      if (recycledProofs.length === 0) throw new Error('Cashu auction promotion produced no escrow proofs')
      const recycledAmount = proofAmount(recycledProofs)
      if (recycledAmount !== sourceData.settlementAmount) {
        throw new Error('Cashu auction promotion output does not exactly match the funded bid amount')
      }
      if (!recycledProofs.every(proof => proofPolicyMatches(proof, {
        tradeId: recycleArgs.target.tradeId,
        settlementId: recycleArgs.target.settlementId,
        locktime: recycleArgs.target.locktime,
        policyType: cashuEscrowPolicyType,
        ...recycleArgs.target.participants,
      }))) {
        throw new Error('Cashu auction promotion output policy mismatch')
      }
      const recycledProof = cashuPaymentProof({
        policyType: cashuEscrowPolicyType,
        mintUrl: sourceData.mint,
        unit: sourceData.unit,
        amount: cashuProofAmountTemplate(sourceParams, sourceData.settlementAmount),
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
        receipt: {
          status: 'completed',
          operationId: intent.operationId,
          externalId: sha256Hex(sortedJson({
            mint: sourceData.mint,
            sourceSettlementId: recycleArgs.source.settlementId,
            targetSettlementId: recycleArgs.target.settlementId,
            proofCommitments: recycledProofs.map(proof => proof.C),
          })),
          evidence: {
            mint: sourceData.mint,
            unit: sourceData.unit,
            sourceSettlementId: recycleArgs.source.settlementId,
            targetSettlementId: recycleArgs.target.settlementId,
            amount: recycledAmount.toString(),
          },
        },
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
