import type {
  MarketplaceDriverAmount,
  MarketplaceDriverAuctionPolicy,
  MarketplaceDriverAuctionSettlementIntent,
  MarketplaceDriverAuctionSettlementResult,
  MarketplaceDriverBolt11PaymentRequest,
  MarketplaceDriverOrderPolicy,
  MarketplaceDriverIdentity,
  MarketplaceDriverPaymentIntent,
  MarketplaceDriverPaymentSettlementIntent,
  MarketplaceDriverPaymentSettlementState,
  MarketplaceDriverPaymentProof,
  MarketplaceDriverPaymentState,
  MarketplaceDriverPaymentSweepInput,
  MarketplaceDriverPaymentSweepState,
  MarketplaceDriverStartContext,
  MarketplaceDriverStartResult,
  MarketplaceDriverSwapResumeContext,
  MarketplaceDriverSwapResumeState,
  MarketplaceDriverValidationExpected,
  MarketplaceDriverValidationRequest,
  MarketplaceDriverValidationResult,
  MarketplaceDriverWatermarkContext,
  MarketplaceDriverWatermarkDiscovery,
} from '@sudonym-btc/marketplace-driver-interface'

export type CashuAmount = {
  value: bigint
  denomination: string
  decimals: number
}

export type CashuMintConfig = {
  mintUrl: string
  unit: string
  denomination: string
  decimals: number
  policyHash?: string
  maxOrderAmount?: string
  data?: Record<string, unknown>
}

export type CashuEscrowPaymentPolicy = {
  method: 'cashu'
  id: string
  type: 'cashu:p2pk-escrow-v1'
  hash: string
  data: {
    mintUrl: string
    unit: string
    [key: string]: unknown
  }
}

export type CashuAuctionPaymentPolicy = {
  method: 'cashu'
  id: string
  type: 'cashu:p2pk-auction-v1'
  hash: string
  data: {
    mintUrl: string
    unit: string
    [key: string]: unknown
  }
}

export type CashuPaymentPolicy = CashuEscrowPaymentPolicy | CashuAuctionPaymentPolicy

export type CashuPaymentAsset = {
  method: 'cashu'
  assetId: string
  currency?: string
  denomination: string
  decimals: number
  appId?: string
  data: {
    mintUrl: string
    unit: string
    [key: string]: unknown
  }
}

export type GenericAmount = MarketplaceDriverAmount
export type GenericPaymentIdentity = MarketplaceDriverIdentity
export type GenericPaymentIntent = MarketplaceDriverPaymentIntent
export type GenericPaymentProof = MarketplaceDriverPaymentProof
export type GenericBolt11PaymentRequest = MarketplaceDriverBolt11PaymentRequest

export type CashuPaymentAmountLimits = {
  source: 'cashu-mint'
  method: 'bolt11'
  mintUrl: string
  unit: string
  amount: {
    value: string
    denomination: string
    decimals: number
  }
  min: {
    value: string
    denomination: string
    decimals: number
  } | null
  max: {
    value: string
    denomination: string
    decimals: number
  } | null
}

export type GenericPolicyPaymentState = MarketplaceDriverPaymentState<GenericPaymentProof>
export type GenericPaymentValidationRequest = MarketplaceDriverValidationRequest
export type GenericPaymentValidationResult = MarketplaceDriverValidationResult & { driver: 'cashu' }
export type GenericPaymentSweepInput = MarketplaceDriverPaymentSweepInput<
  GenericPaymentProof,
  MarketplaceDriverValidationExpected
>
export type GenericPaymentSweepState = MarketplaceDriverPaymentSweepState<GenericPaymentProof>
export type GenericPaymentSettlementIntent = MarketplaceDriverPaymentSettlementIntent<
  GenericPaymentProof,
  MarketplaceDriverValidationExpected
>
export type GenericPaymentSettlementState = MarketplaceDriverPaymentSettlementState<GenericPaymentProof>
export type GenericSwapResumeContext = MarketplaceDriverSwapResumeContext
export type GenericSwapResumeState = MarketplaceDriverSwapResumeState
export type GenericAuctionSettlementIntent = MarketplaceDriverAuctionSettlementIntent<
  GenericPaymentProof,
  MarketplaceDriverValidationExpected
>
export type GenericAuctionSettlementResult = MarketplaceDriverAuctionSettlementResult<GenericPaymentProof>

export type CashuEscrowPolicyState = {
  enabled: boolean
  started: boolean
  mintCount: number
  startSummary: string
  error?: string
}

export type CashuAuctionPolicyState = CashuEscrowPolicyState

export type CashuEscrowPolicy = MarketplaceDriverOrderPolicy<
  GenericPolicyPaymentState,
  CashuEscrowPaymentPolicy,
  CashuPaymentAsset,
  GenericPaymentIntent,
  GenericPaymentValidationRequest,
  GenericPaymentValidationResult,
  GenericPaymentSweepInput,
  GenericPaymentSweepState,
  GenericPaymentSettlementIntent,
  GenericPaymentSettlementState,
  GenericSwapResumeContext,
  GenericSwapResumeState
> & {
  method: 'cashu'
  id: 'cashu:p2pk-escrow-v1'
  policies(): CashuEscrowPaymentPolicy[]
  assets(): CashuPaymentAsset[]
  discoverHighWatermark(context: MarketplaceDriverWatermarkContext): Promise<
    MarketplaceDriverWatermarkDiscovery & {
    policy: 'cashu:p2pk-escrow-v1'
    maxUsedIndex: number
    nextUnusedIndex: number
    scannedFrom: number
    scannedThrough: number
    unusedWindow: number
    usedIndexes: number[]
    recoveryActions: unknown[]
  }>
  startup(context: MarketplaceDriverStartContext): Promise<
    MarketplaceDriverStartResult & {
    policy: 'cashu:p2pk-escrow-v1'
    data: Record<string, unknown>
  }>
  sweepPayment(payment: GenericPaymentSweepInput): AsyncIterable<GenericPaymentSweepState>
  pay(intent: GenericPaymentIntent): AsyncIterable<GenericPolicyPaymentState>
  validatePayment(request: GenericPaymentValidationRequest): Promise<GenericPaymentValidationResult>
  state(): CashuEscrowPolicyState
}

export type CashuAuctionPolicy = MarketplaceDriverAuctionPolicy<
  GenericPolicyPaymentState,
  CashuAuctionPaymentPolicy,
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
  GenericAuctionSettlementIntent,
  GenericAuctionSettlementResult
> & {
  method: 'cashu'
  id: 'cashu:p2pk-auction-v1'
  policies(): CashuAuctionPaymentPolicy[]
  assets(): CashuPaymentAsset[]
  discoverHighWatermark(context: MarketplaceDriverWatermarkContext): Promise<
    MarketplaceDriverWatermarkDiscovery & {
    policy: 'cashu:p2pk-auction-v1'
    maxUsedIndex: number
    nextUnusedIndex: number
    scannedFrom: number
    scannedThrough: number
    unusedWindow: number
    usedIndexes: number[]
    recoveryActions: unknown[]
  }>
  startup(context: MarketplaceDriverStartContext): Promise<
    MarketplaceDriverStartResult & {
    policy: 'cashu:p2pk-auction-v1'
    data: Record<string, unknown>
  }>
  sweepPayment(payment: GenericPaymentSweepInput): AsyncIterable<GenericPaymentSweepState>
  pay(intent: GenericPaymentIntent): AsyncIterable<GenericPolicyPaymentState>
  validatePayment(request: GenericPaymentValidationRequest): Promise<GenericPaymentValidationResult>
  refundPayment(intent: GenericAuctionSettlementIntent & {
    action: 'auction_refund'
    refundPercent: number
  }): Promise<GenericAuctionSettlementResult>
  recyclePayment(intent: GenericAuctionSettlementIntent & {
    action: 'auction_promote'
    targetTradeId: string
    targetOrderGroupId: string
  }): Promise<GenericAuctionSettlementResult>
  state(): CashuAuctionPolicyState
}
