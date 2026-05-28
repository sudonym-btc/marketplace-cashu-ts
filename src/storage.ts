export type CashuEscrowOperationStatus =
  | 'quote_created'
  | 'payment_required'
  | 'minting'
  | 'paid'
  | 'completed'
  | 'failed'

export type CashuEscrowOperation = {
  id: string
  kind: 'cashu_escrow_mint'
  status: CashuEscrowOperationStatus
  tradeId: string
  settlementId: string
  accountIndex: number
  mintUrl: string
  unit: string
  quoteId?: string
  request?: string
  proofs?: string[]
  error?: string
  data: Record<string, unknown>
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
    return this.records.get(id) ?? null
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
