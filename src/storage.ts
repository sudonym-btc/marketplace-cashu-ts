export type CashuEscrowOperationStatus =
  | 'quote_created'
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
  quoteExpiry?: number | null
  mintKeysetId?: string
  recycleFeeReserve?: string
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
