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
  denomination: string
  decimals: number
  appId?: string
  data: {
    mintUrl: string
    unit: string
    [key: string]: unknown
  }
}

export type GenericPaymentIdentity = {
  pubkey?: string
  address?: string
  data?: Record<string, unknown>
}

export type GenericPaymentIntent = {
  method: string
  subject: 'order' | 'bid'
  tradeId: string
  settlementId: string
  accountIndex: number
  seed?: string
  amount: {
    value: string
    denomination: string
    decimals: number
  }
  fee: {
    value: string
    denomination: string
    decimals: number
  }
  asset: {
    method: string
    assetId: string
    denomination: string
    decimals: number
    data?: Record<string, unknown>
  }
  policy: {
    method: string
    id: string
    type?: string
    hash?: string
    data?: Record<string, unknown>
  }
  contract: {
    type: string
    params: Record<string, unknown>
  }
  participants: {
    buyer?: GenericPaymentIdentity
    seller: GenericPaymentIdentity
    escrow: GenericPaymentIdentity
  }
  unlockAt: number
  metadata?: Record<string, unknown>
}

export type GenericPaymentProof = {
  method: string
  params: Record<string, unknown>
}

export type GenericBolt11PaymentRequest = {
  type: 'bolt11'
  bolt11: string
  amount?: {
    value: string
    denomination: string
    decimals: number
  }
  description?: string
  expiresAt?: number
  data?: Record<string, unknown>
}

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

export type GenericPolicyPaymentState =
  | {
      type: 'payment_required'
      request: GenericBolt11PaymentRequest
      proof?: GenericPaymentProof | null
      data?: Record<string, unknown>
    }
  | {
      type: 'payment_progress'
      status: string
      proof?: GenericPaymentProof | null
      data?: Record<string, unknown>
    }
  | {
      type: 'paid'
      proof: GenericPaymentProof
      data?: Record<string, unknown>
    }
  | {
      type: 'completed'
      proof?: GenericPaymentProof | null
      data?: Record<string, unknown>
    }

export type GenericPaymentValidationRequest = {
  method: string
  proof: GenericPaymentProof
  expected: {
    settlementId: string
    tradeId?: string
    amount?: {
      value: string
      denomination: string
      decimals: number
    }
    asset?: {
      denomination?: string
      decimals?: number
      assetId?: string
    }
    contract?: {
      chainId?: number
      address?: string
      bytecodeHash?: string
      params?: Record<string, unknown>
    }
    participants?: {
      buyer?: GenericPaymentIdentity
      seller?: GenericPaymentIdentity
      escrow?: GenericPaymentIdentity
    }
    fee?: {
      value: string
      denomination: string
      decimals: number
    }
  }
  now?: number
}

export type GenericPaymentValidationResult = {
  method: 'cashu'
  status: 'valid' | 'invalid' | 'pending' | 'expired' | 'unverifiable'
  confirmations?: number
  amountMatched?: boolean
  assetMatched?: boolean
  recipientMatched?: boolean
  escrowMatched?: boolean
  data?: Record<string, unknown>
  error?: string
}

export type GenericPaymentRecoveryItem = {
  subject: 'order' | 'bid'
  group?: unknown
  payment?: unknown
  proof: GenericPaymentProof
  expected?: GenericPaymentValidationRequest['expected']
}

export type GenericPaymentRecoveryState =
  | { type: 'noop'; data?: Record<string, unknown> }
  | { type: 'progress'; status: string; data?: Record<string, unknown> }
  | { type: 'recovered'; data?: Record<string, unknown> }

export type GenericAuctionSettlementIntent = {
  subject: 'bid'
  action: 'auction_refund' | 'auction_promote'
  group?: unknown
  payment?: unknown
  proof: GenericPaymentProof
  expected?: GenericPaymentValidationRequest['expected']
  validation?: unknown
  refundPercent?: number
  targetTradeId?: string
  targetOrderGroupId?: string
  targetUnlockAt?: number
  recycleArgs?: unknown
  data?: Record<string, unknown>
}

export type GenericAuctionSettlementResult = {
  proof: GenericPaymentProof
  inputs?: Array<Record<string, unknown>>
  outputs?: Array<Record<string, unknown>>
  data?: Record<string, unknown>
}

export type CashuEscrowPolicyState = {
  enabled: boolean
  started: boolean
  mintCount: number
  startSummary: string
  error?: string
}

export type CashuAuctionPolicyState = CashuEscrowPolicyState

export type CashuEscrowPolicy = {
  method: 'cashu'
  id: 'cashu:p2pk-escrow-v1'
  subject: 'order'
  family: 'escrow'
  policies(): CashuEscrowPaymentPolicy[]
  assets(): CashuPaymentAsset[]
  discoverHighWatermark(context: {
    seed: string
    highWaterMark: number
    unusedWindow: number
    now?: number
  }): Promise<{
    policy: 'cashu:p2pk-escrow-v1'
    maxUsedIndex: number
    nextUnusedIndex: number
    scannedFrom: number
    scannedThrough: number
    unusedWindow: number
    usedIndexes: number[]
    recoveryActions: unknown[]
  }>
  startup(context: {
    seed: string
    highWaterMark: number
    nextUnusedIndex: number
    unusedWindow: number
    discovery: unknown
    now?: number
  }): Promise<{
    policy: 'cashu:p2pk-escrow-v1'
    data: Record<string, unknown>
  }>
  recover(payment: GenericPaymentRecoveryItem): AsyncIterable<GenericPaymentRecoveryState>
  pay(intent: GenericPaymentIntent): AsyncIterable<GenericPolicyPaymentState>
  validatePayment(request: GenericPaymentValidationRequest): Promise<GenericPaymentValidationResult>
  state(): CashuEscrowPolicyState
}

export type CashuAuctionPolicy = {
  method: 'cashu'
  id: 'cashu:p2pk-auction-v1'
  subject: 'bid'
  family: 'auction'
  policies(): CashuAuctionPaymentPolicy[]
  assets(): CashuPaymentAsset[]
  discoverHighWatermark(context: {
    seed: string
    highWaterMark: number
    unusedWindow: number
    now?: number
  }): Promise<{
    policy: 'cashu:p2pk-auction-v1'
    maxUsedIndex: number
    nextUnusedIndex: number
    scannedFrom: number
    scannedThrough: number
    unusedWindow: number
    usedIndexes: number[]
    recoveryActions: unknown[]
  }>
  startup(context: {
    seed: string
    highWaterMark: number
    nextUnusedIndex: number
    unusedWindow: number
    discovery: unknown
    now?: number
  }): Promise<{
    policy: 'cashu:p2pk-auction-v1'
    data: Record<string, unknown>
  }>
  recover(payment: GenericPaymentRecoveryItem): AsyncIterable<GenericPaymentRecoveryState>
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
