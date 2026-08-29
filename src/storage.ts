export type CashuEscrowOperationStatus =
  | 'quote_created'
  | 'quote_requesting'
  | 'payment_required'
  | 'minting'
  | 'paid'
  | 'completed'
  | 'reconciliation_required'
  | 'failed'

/**
 * Public, allowlisted recovery metadata for a Cashu mint operation.
 *
 * Bearer proofs, seeds, private keys, prepared outputs, and other secret
 * material MUST NOT be stored in this record. Mint outputs are derived again
 * from the caller-provided marketplace seed and request fingerprint.
 */
export type CashuEscrowOperationData = {
  version: 1
  requestFingerprint: string
  outputDerivationVersion: 1
  policyType: 'cashu:p2pk-escrow-v1' | 'cashu:p2pk-auction-v1'
  policyHash: string
  conditionHash: string
  buyerCashuPubkey: string
  sellerCashuPubkey: string
  arbiterCashuPubkey: string
  locktime: number
  fundingAmount: string
  paymentAmount: string
  escrowFee: string
  denomination: string
  decimals: number
  description: string
  /**
   * Versioned marker proving `quote_created` was persisted before any mint
   * quote request was attempted. Records without this marker predate the
   * exactly-once claim protocol and must not be retried automatically.
   */
  quoteCreationVersion?: 1
  quoteExpiry?: number | null
  mintKeysetId?: string
  /** Operator-attested active horizon for an auction output keyset (Unix seconds). */
  mintKeysetActiveUntil?: number
  recycleFeeReserve?: string
}

/**
 * Short-lived ownership metadata for the one non-idempotent mint-quote call.
 *
 * A `reserved` claim may be replaced after expiry because the durable status
 * still proves that no request has started. A `requesting` claim is the
 * irreversible point of no return and must never be stolen or retried.
 */
export type CashuEscrowOperationClaim = {
  version: 1
  purpose: 'mint_quote'
  phase: 'reserved' | 'requesting'
  owner: string
  /** Unix epoch milliseconds. */
  expiresAt: number
}

export type CashuEscrowOperation = {
  id: string
  kind: 'cashu_escrow_mint' | 'cashu_auction_mint'
  status: CashuEscrowOperationStatus
  tradeId: string
  settlementId: string
  accountIndex: number
  mintUrl: string
  unit: string
  quoteId?: string
  request?: string
  error?: string
  /** Monotonic revision used by compareAndSet(). Legacy records imply zero. */
  revision?: number
  claim?: CashuEscrowOperationClaim
  data: CashuEscrowOperationData
  createdAt: number
  updatedAt: number
}

export type CashuEscrowOperationQuery = {
  status?: CashuEscrowOperationStatus | CashuEscrowOperationStatus[]
  tradeId?: string
  settlementId?: string
  quoteId?: string
  mintUrl?: string
}

export type CashuEscrowStorage = {
  get(id: string): Promise<CashuEscrowOperation | null>
  /** Atomically insert a new operation, returning false when the id exists. */
  create?(record: CashuEscrowOperation): Promise<boolean>
  /**
   * Atomically replace an operation only when its current revision equals
   * `expectedRevision`. The replacement revision must be
   * `expectedRevision + 1`.
   *
   * Durable stores shared by more than one policy instance or process MUST
   * implement this primitive. It lets a caller take a pre-request lease while
   * ensuring only one caller can cross the quote-request point of no return.
   */
  compareAndSet?(
    id: string,
    expectedRevision: number,
    replacement: CashuEscrowOperation,
  ): Promise<boolean>
  put(record: CashuEscrowOperation): Promise<void>
  list(query?: CashuEscrowOperationQuery): Promise<CashuEscrowOperation[]>
  delete(id: string): Promise<void>
}

function matchStatus(
  actual: CashuEscrowOperationStatus,
  expected?: CashuEscrowOperationStatus | CashuEscrowOperationStatus[],
): boolean {
  if (!expected) return true
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected
}

export class MemoryCashuEscrowStore implements CashuEscrowStorage {
  private readonly records = new Map<string, CashuEscrowOperation>()

  async get(id: string): Promise<CashuEscrowOperation | null> {
    const record = this.records.get(id)
    return record ? structuredClone(record) : null
  }

  async create(record: CashuEscrowOperation): Promise<boolean> {
    if (this.records.has(record.id)) return false
    this.records.set(record.id, structuredClone(record))
    return true
  }

  async compareAndSet(
    id: string,
    expectedRevision: number,
    replacement: CashuEscrowOperation,
  ): Promise<boolean> {
    const current = this.records.get(id)
    if (!current || (current.revision ?? 0) !== expectedRevision) return false
    if (replacement.id !== id || replacement.revision !== expectedRevision + 1) {
      throw new Error('Cashu compareAndSet replacement must increment the matching operation revision')
    }
    this.records.set(id, structuredClone(replacement))
    return true
  }

  async put(record: CashuEscrowOperation): Promise<void> {
    this.records.set(record.id, structuredClone(record))
  }

  async list(query: CashuEscrowOperationQuery = {}): Promise<CashuEscrowOperation[]> {
    return [...this.records.values()]
      .filter(record => matchStatus(record.status, query.status))
      .filter(record => !query.tradeId || record.tradeId === query.tradeId)
      .filter(record => !query.settlementId || record.settlementId === query.settlementId)
      .filter(record => !query.quoteId || record.quoteId === query.quoteId)
      .filter(record => !query.mintUrl || record.mintUrl === query.mintUrl)
      .map(record => structuredClone(record))
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id)
  }
}
