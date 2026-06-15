import {
  Amount,
  CheckStateEnum,
  OutputData,
  P2PKBuilder,
  deserializeProofs,
  parseP2PKSecret,
  serializeProofs,
  sumProofs,
  type P2PKTag,
  type Proof,
  type SerializedOutputData,
  type SwapPreview,
  type Wallet,
} from '@cashu/cashu-ts'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  isMarketplaceDriverEncryptedPaymentProofParams,
  type MarketplaceDriverPaymentTerms,
  type MarketplaceDriverPaymentTermAmount,
  type MarketplaceDriverPaymentTermLock,
  type MarketplaceDriverPaymentTermOutput,
  type MarketplaceDriverPaymentTermPath,
} from '@sudonym-btc/marketplace-driver-interface'

import type { CashuAmount, GenericPaymentProof } from '../types.js'
import { normalizePublicKey } from '../utils/hex.js'

export const cashuEscrowPolicyType = 'cashu:p2pk-escrow-v1' as const
export const cashuAuctionPolicyType = 'cashu:p2pk-auction-v1' as const

export type CashuP2pkPolicyType = typeof cashuEscrowPolicyType | typeof cashuAuctionPolicyType

export type CashuEscrowParticipants = {
  buyerPubkey: string
  sellerPubkey: string
  arbiterPubkey: string
}

export type CashuEscrowPolicyInput = CashuEscrowParticipants & {
  tradeId: string
  settlementId: string
  locktime: number
  policyType?: CashuP2pkPolicyType
}

export type CashuRecycleArgs = {
  version: 1
  type: 'cashu:p2pk-auction-promote-v1'
  fromPolicyType: typeof cashuAuctionPolicyType
  toPolicyType: typeof cashuEscrowPolicyType
  source: {
    tradeId: string
    settlementId: string
    policyType: typeof cashuAuctionPolicyType
  }
  message: string
  messageHash: string
  signerPubkey: string
  signature: string
  target: {
    tradeId: string
    settlementId: string
    policyType: typeof cashuEscrowPolicyType
    policyHash: string
    conditionHash: string
    locktime: number
    participants: CashuEscrowParticipants
    p2pkOptions: ReturnType<typeof cashuEscrowP2pkOptions>
    order?: Record<string, unknown>
  }
  swap?: CashuSerializedSwapPreview
}

export type CashuSerializedSwapPreview = {
  version: 1
  amount: string
  fees: string
  keysetId: string
  inputs: string[]
  sendOutputs: SerializedOutputData[]
  keepOutputs: SerializedOutputData[]
  unselectedProofs: string[]
}

const cashuSplitChunkCount = 10

export function canonicalCashuAssetId(mintUrl: string, unit: string): string {
  return `cashu:${unit}:${mintUrl}`
}

function cashuP2pkPolicyHash(input: {
  policyType: CashuP2pkPolicyType
  mintUrl: string
  unit: string
  locktime?: number
  participants?: CashuEscrowParticipants
}): string {
  const payload = JSON.stringify({
    type: input.policyType,
    mintUrl: input.mintUrl,
    unit: input.unit,
    ...(input.locktime !== undefined ? { locktime: input.locktime } : {}),
    ...(input.participants
      ? {
          participants: {
            buyerPubkey: normalizePublicKey(input.participants.buyerPubkey, 'buyer cashu pubkey'),
            sellerPubkey: normalizePublicKey(input.participants.sellerPubkey, 'seller cashu pubkey'),
            arbiterPubkey: normalizePublicKey(input.participants.arbiterPubkey, 'arbiter cashu pubkey'),
          },
        }
      : {}),
  })
  return `0x${bytesToHex(sha256(new TextEncoder().encode(payload)))}`
}

export function cashuEscrowPolicyHash(input: {
  mintUrl: string
  unit: string
  locktime?: number
  participants?: CashuEscrowParticipants
}): string {
  return cashuP2pkPolicyHash({ ...input, policyType: cashuEscrowPolicyType })
}

export function cashuAuctionPolicyHash(input: {
  mintUrl: string
  unit: string
  locktime?: number
  participants?: CashuEscrowParticipants
}): string {
  return cashuP2pkPolicyHash({ ...input, policyType: cashuAuctionPolicyType })
}

function p2pkTags(input: CashuEscrowPolicyInput, tag: 'escrow' | 'auction', policyType: CashuP2pkPolicyType): P2PKTag[] {
  const tags: P2PKTag[] = [
    ['marketplace', tag],
    ['trade', input.tradeId],
    ['settlement', input.settlementId],
    ['policy', policyType],
  ]
  if (tag === 'auction') tags.push(['seller', normalizePublicKey(input.sellerPubkey, 'seller cashu pubkey')])
  return tags
}

export function cashuEscrowP2pkOptions(input: CashuEscrowPolicyInput) {
  return new P2PKBuilder()
    .addLockPubkey([
      normalizePublicKey(input.buyerPubkey, 'buyer cashu pubkey'),
      normalizePublicKey(input.sellerPubkey, 'seller cashu pubkey'),
      normalizePublicKey(input.arbiterPubkey, 'arbiter cashu pubkey'),
    ])
    .requireLockSignatures(2)
    .addRefundPubkey(normalizePublicKey(input.sellerPubkey, 'seller cashu refund pubkey'))
    .requireRefundSignatures(1)
    .lockUntil(input.locktime)
    .sigAll()
    .addTags(p2pkTags(input, 'escrow', cashuEscrowPolicyType))
    .toOptions()
}

export function cashuAuctionP2pkOptions(input: CashuEscrowPolicyInput) {
  return new P2PKBuilder()
    .addLockPubkey([
      normalizePublicKey(input.buyerPubkey, 'buyer cashu pubkey'),
      normalizePublicKey(input.arbiterPubkey, 'arbiter cashu pubkey'),
    ])
    .requireLockSignatures(2)
    .addRefundPubkey(normalizePublicKey(input.buyerPubkey, 'buyer cashu refund pubkey'))
    .requireRefundSignatures(1)
    .lockUntil(input.locktime)
    .sigAll()
    .addTags(p2pkTags(input, 'auction', cashuAuctionPolicyType))
    .toOptions()
}

export function proofPolicyMatches(
  proof: Proof,
  input: CashuEscrowPolicyInput,
): boolean {
  try {
    const secret = parseP2PKSecret(proof.secret)
    if (secret[0] !== 'P2PK') return false
    const tags = secret[1].tags ?? []
    const policyType = tags.find(tag => tag[0] === 'policy')?.[1]
    const expectedPolicy = input.policyType ?? cashuEscrowPolicyType
    if (policyType !== expectedPolicy) return false
    const isAuction = expectedPolicy === cashuAuctionPolicyType
    const expectedKeys = isAuction
      ? [
          normalizePublicKey(input.buyerPubkey, 'buyer cashu pubkey'),
          normalizePublicKey(input.arbiterPubkey, 'arbiter cashu pubkey'),
        ]
      : [
          normalizePublicKey(input.buyerPubkey, 'buyer cashu pubkey'),
          normalizePublicKey(input.sellerPubkey, 'seller cashu pubkey'),
          normalizePublicKey(input.arbiterPubkey, 'arbiter cashu pubkey'),
        ]
    const lockKey = normalizePublicKey(secret[1].data, 'proof lock pubkey')
    if (!expectedKeys.includes(lockKey)) return false
    const additionalLockKeys = tags
      .filter(tag => tag[0] === 'pubkeys')
      .flatMap(tag => tag.slice(1))
      .map(value => normalizePublicKey(value, 'proof lock pubkey'))
    const allLockKeys = new Set([lockKey, ...additionalLockKeys])
    if (!expectedKeys.every(key => allLockKeys.has(key))) return false
    const locktime = tags.find(tag => tag[0] === 'locktime')?.[1]
    if (locktime !== String(input.locktime)) return false
    const nSigs = tags.find(tag => tag[0] === 'n_sigs')?.[1]
    if (nSigs !== '2') return false
    const sigFlag = tags.find(tag => tag[0] === 'sigflag')?.[1]
    if (sigFlag !== 'SIG_ALL') return false
    const refund = tags.filter(tag => tag[0] === 'refund').map(tag => tag[1])
    const expectedRefund = isAuction
      ? normalizePublicKey(input.buyerPubkey, 'buyer cashu refund pubkey')
      : normalizePublicKey(input.sellerPubkey, 'seller cashu refund pubkey')
    if (!refund.includes(expectedRefund)) return false
    const tradeId = tags.find(tag => tag[0] === 'trade')?.[1]
    if (tradeId !== input.tradeId) return false
    const settlementId = tags.find(tag => tag[0] === 'settlement')?.[1]
    if (settlementId !== input.settlementId) return false
    return true
  } catch {
    return false
  }
}

export function cashuPromotionAuthorization(input: {
  buyerPrivateKey: string
  buyerPubkey: string
  source: CashuRecycleArgs['source']
  target: CashuRecycleArgs['target']
  swap?: CashuSerializedSwapPreview
}): CashuRecycleArgs {
  const target = {
    ...input.target,
    participants: {
      buyerPubkey: normalizePublicKey(input.target.participants.buyerPubkey, 'buyer cashu pubkey'),
      sellerPubkey: normalizePublicKey(input.target.participants.sellerPubkey, 'seller cashu pubkey'),
      arbiterPubkey: normalizePublicKey(input.target.participants.arbiterPubkey, 'arbiter cashu pubkey'),
    },
  }
  const message = JSON.stringify({
    version: 1,
    type: 'cashu:p2pk-auction-promote-v1',
    fromPolicyType: cashuAuctionPolicyType,
    toPolicyType: cashuEscrowPolicyType,
    source: input.source,
    target,
    ...(input.swap ? { swap: input.swap } : {}),
  })
  const digest = sha256(new TextEncoder().encode(message))
  return {
    version: 1,
    type: 'cashu:p2pk-auction-promote-v1',
    fromPolicyType: cashuAuctionPolicyType,
    toPolicyType: cashuEscrowPolicyType,
    source: input.source,
    message,
    messageHash: `0x${bytesToHex(digest)}`,
    signerPubkey: normalizePublicKey(input.buyerPubkey, 'buyer cashu pubkey'),
    signature: bytesToHex(schnorr.sign(digest, hexToBytes(input.buyerPrivateKey))),
    target,
    ...(input.swap ? { swap: input.swap } : {}),
  }
}

export function serializeCashuSwapPreview(preview: SwapPreview): CashuSerializedSwapPreview {
  return {
    version: 1,
    amount: preview.amount.toString(),
    fees: preview.fees.toString(),
    keysetId: preview.keysetId,
    inputs: serializeProofs(preview.inputs),
    sendOutputs: (preview.sendOutputs ?? []).map(output => OutputData.serialize(output)),
    keepOutputs: (preview.keepOutputs ?? []).map(output => OutputData.serialize(output)),
    unselectedProofs: serializeProofs(preview.unselectedProofs ?? []),
  }
}

export function deserializeCashuSwapPreview(preview: CashuSerializedSwapPreview): SwapPreview {
  return {
    amount: Amount.from(preview.amount),
    fees: Amount.from(preview.fees),
    keysetId: preview.keysetId,
    inputs: deserializeProofs(preview.inputs),
    sendOutputs: preview.sendOutputs.map(output => OutputData.deserialize(output)),
    keepOutputs: preview.keepOutputs.map(output => OutputData.deserialize(output)),
    unselectedProofs: deserializeProofs(preview.unselectedProofs),
  }
}

function termAmount(
  value: bigint,
  denomination: string,
  decimals: number,
  assetId: string,
): MarketplaceDriverPaymentTermAmount {
  return {
    value: value.toString(),
    denomination,
    decimals,
    assetId,
  }
}

function termOutput(
  role: string,
  id: string,
  amount: MarketplaceDriverPaymentTermAmount,
): MarketplaceDriverPaymentTermOutput {
  return { role, id, amount }
}

function splitAmount(total: bigint, chunk: number, chunks = cashuSplitChunkCount): [bigint, bigint] {
  const seller = total * BigInt(chunk) / BigInt(chunks)
  return [total - seller, seller]
}

function terminalOutputs(
  participant: CashuEscrowParticipants,
  paymentAmount: MarketplaceDriverPaymentTermAmount,
  escrowFee: MarketplaceDriverPaymentTermAmount,
  allocations: Array<{ role: 'buyer' | 'seller'; amount: MarketplaceDriverPaymentTermAmount }>,
): MarketplaceDriverPaymentTermOutput[] {
  return [
    ...allocations.map(allocation => termOutput(
      allocation.role,
      allocation.role === 'buyer' ? participant.buyerPubkey : participant.sellerPubkey,
      allocation.amount,
    )),
    ...(escrowFee.value !== '0' ? [termOutput('arbiter', participant.arbiterPubkey, escrowFee)] : []),
  ]
}

function cashuEscrowTermPaths(input: {
  participants: CashuEscrowParticipants
  paymentAmount: MarketplaceDriverPaymentTermAmount
  escrowFee: MarketplaceDriverPaymentTermAmount
  locktime: number
}): MarketplaceDriverPaymentTermPath[] {
  const total = BigInt(input.paymentAmount.value)
  return [
    {
      id: 'release',
      requires: [
        { role: 'seller', condition: 'signature' },
        { role: 'arbiter', condition: 'signature' },
      ],
      result: {
        type: 'terminal',
        outputs: terminalOutputs(input.participants, input.paymentAmount, input.escrowFee, [
          { role: 'seller', amount: input.paymentAmount },
        ]),
      },
    },
    {
      id: 'refund',
      requires: [
        { role: 'buyer', condition: 'signature' },
        { role: 'arbiter', condition: 'signature' },
      ],
      result: {
        type: 'terminal',
        outputs: terminalOutputs(input.participants, input.paymentAmount, input.escrowFee, [
          { role: 'buyer', amount: input.paymentAmount },
        ]),
      },
    },
    ...Array.from({ length: cashuSplitChunkCount + 1 }, (_, chunk): MarketplaceDriverPaymentTermPath => {
      const [buyer, seller] = splitAmount(total, chunk)
      return {
        id: `split-${chunk}-of-${cashuSplitChunkCount}`,
        requires: [
          { role: 'arbiter', condition: 'signature' },
        ],
        result: {
          type: 'terminal',
          outputs: terminalOutputs(input.participants, input.paymentAmount, input.escrowFee, [
            { role: 'buyer', amount: { ...input.paymentAmount, value: buyer.toString() } },
            { role: 'seller', amount: { ...input.paymentAmount, value: seller.toString() } },
          ]),
        },
      }
    }),
    {
      id: 'timeout',
      after: input.locktime,
      requires: [{ role: 'seller', condition: 'timeout' }],
      result: {
        type: 'terminal',
        outputs: terminalOutputs(input.participants, input.paymentAmount, input.escrowFee, [
          { role: 'seller', amount: input.paymentAmount },
        ]),
      },
    },
  ]
}

function cashuEscrowTermLock(input: {
  policyType: CashuP2pkPolicyType
  participants: CashuEscrowParticipants
  fundedAmount: MarketplaceDriverPaymentTermAmount
  paymentAmount: MarketplaceDriverPaymentTermAmount
  escrowFee: MarketplaceDriverPaymentTermAmount
  tradeId: string
  settlementId: string
  locktime: number
  paths?: MarketplaceDriverPaymentTermPath[]
}): MarketplaceDriverPaymentTermLock {
  const isAuction = input.policyType === cashuAuctionPolicyType
  return {
    id: input.settlementId,
    policyId: input.policyType,
    kind: 'threshold',
    amount: input.fundedAmount,
    controls: isAuction
      ? [
          { role: 'buyer', id: input.participants.buyerPubkey },
          { role: 'arbiter', id: input.participants.arbiterPubkey },
        ]
      : [
          { role: 'buyer', id: input.participants.buyerPubkey },
          { role: 'seller', id: input.participants.sellerPubkey },
          { role: 'arbiter', id: input.participants.arbiterPubkey },
        ],
    threshold: 2,
    conditions: {
      tradeId: input.tradeId,
      settlementId: input.settlementId,
      locktime: input.locktime,
      arbitration: isAuction
        ? { type: 'promotable' }
        : { type: 'chunked', chunks: cashuSplitChunkCount },
    },
    paths: input.paths ?? (isAuction
      ? [
          {
            id: 'timeout',
            after: input.locktime,
            requires: [{ role: 'buyer', condition: 'timeout' }],
            result: {
              type: 'terminal',
              outputs: [termOutput('buyer', input.participants.buyerPubkey, input.fundedAmount)],
            },
          },
        ]
      : cashuEscrowTermPaths({
          participants: input.participants,
          paymentAmount: input.paymentAmount,
          escrowFee: input.escrowFee,
          locktime: input.locktime,
        })),
  }
}

export function cashuPaymentTerms(input: {
  policyType: CashuP2pkPolicyType
  mintUrl: string
  unit: string
  amount: CashuAmount
  paymentAmount: bigint
  escrowFee: bigint
  denomination: string
  decimals: number
  tradeId: string
  settlementId: string
  participants: CashuEscrowParticipants
  locktime: number
  recycleArgs?: CashuRecycleArgs
}): MarketplaceDriverPaymentTerms {
  const assetId = canonicalCashuAssetId(input.mintUrl, input.unit)
  const paymentAmount = termAmount(input.paymentAmount, input.denomination, input.decimals, assetId)
  const fundedAmount = termAmount(input.amount.value, input.denomination, input.decimals, assetId)
  const escrowFee = termAmount(input.escrowFee, input.denomination, input.decimals, assetId)
  const paths = input.policyType === cashuAuctionPolicyType && input.recycleArgs
    ? [
        {
          id: 'promote',
          requires: [
            { role: 'buyer', condition: 'signature' },
            { role: 'arbiter', condition: 'signature' },
          ],
          result: {
            type: 'lock' as const,
            lock: cashuEscrowTermLock({
              policyType: cashuEscrowPolicyType,
              participants: input.recycleArgs.target.participants,
              fundedAmount,
              paymentAmount,
              escrowFee,
              tradeId: input.recycleArgs.target.tradeId,
              settlementId: input.recycleArgs.target.settlementId,
              locktime: input.recycleArgs.target.locktime,
            }),
          },
        },
        {
          id: 'timeout',
          after: input.locktime,
          requires: [{ role: 'buyer', condition: 'timeout' }],
          result: {
            type: 'terminal' as const,
            outputs: [termOutput('buyer', input.participants.buyerPubkey, fundedAmount)],
          },
        },
      ]
    : undefined
  return {
    version: 1,
    asset: paymentAmount,
    parties: [
      { role: 'buyer', id: input.participants.buyerPubkey },
      { role: 'seller', id: input.participants.sellerPubkey },
      { role: 'arbiter', id: input.participants.arbiterPubkey },
    ],
    lock: cashuEscrowTermLock({
      policyType: input.policyType,
      participants: input.participants,
      fundedAmount,
      paymentAmount,
      escrowFee,
      tradeId: input.tradeId,
      settlementId: input.settlementId,
      locktime: input.locktime,
      ...(paths ? { paths } : {}),
    }),
  }
}

export function cashuPaymentProof(input: {
  policyType?: CashuP2pkPolicyType
  mintUrl: string
  unit: string
  amount: CashuAmount
  escrowFee: CashuAmount
  tradeId: string
  settlementId: string
  quoteId: string
  proofs: Proof[]
  participants: CashuEscrowParticipants
  locktime: number
  policyHash: string
  conditionHash: string
  recycleArgs?: CashuRecycleArgs
}): GenericPaymentProof {
  const policyType = input.policyType ?? cashuEscrowPolicyType
  const paymentAmount = input.amount.value - input.escrowFee.value
  if (paymentAmount < 0n) throw new Error('Cashu escrow fee exceeds funded amount')
  const publicDenomination = input.amount.denomination.toUpperCase() === 'SAT' ? 'BTC' : input.amount.denomination
  const publicDecimals = publicDenomination.toUpperCase() === 'BTC' ? 8 : input.amount.decimals
  const terms = cashuPaymentTerms({
    policyType,
    mintUrl: input.mintUrl,
    unit: input.unit,
    amount: input.amount,
    paymentAmount,
    escrowFee: input.escrowFee.value,
    denomination: publicDenomination,
    decimals: publicDecimals,
    tradeId: input.tradeId,
    settlementId: input.settlementId,
    participants: input.participants,
    locktime: input.locktime,
    ...(input.recycleArgs ? { recycleArgs: input.recycleArgs } : {}),
  })
  return {
    driver: policyType,
    terms,
    params: {
      version: 1,
      policyType,
      policyHash: input.policyHash,
      conditionHash: input.conditionHash,
      ...(input.recycleArgs ? { recycleArgs: input.recycleArgs } : {}),
      mint: input.mintUrl,
      unit: input.unit,
      amount: input.amount.value.toString(),
      paymentAmount: paymentAmount.toString(),
      denomination: publicDenomination,
      decimals: publicDecimals,
      escrowFee: input.escrowFee.value.toString(),
      tradeId: input.tradeId,
      settlementId: input.settlementId,
      quoteId: input.quoteId,
      locktime: input.locktime,
      participants: input.participants,
      proofs: serializeProofs(input.proofs),
    },
  }
}

export function clearPaymentProofParams(proof: GenericPaymentProof): Record<string, unknown> {
  if (isMarketplaceDriverEncryptedPaymentProofParams(proof.params)) {
    throw new Error('Cashu payment proof params are encrypted')
  }
  return proof.params as Record<string, unknown>
}

export function proofsFromPaymentProofParams(params: Record<string, unknown>): Proof[] {
  const rawProofs = params.proofs
  if (!Array.isArray(rawProofs)) throw new Error('Cashu payment proof is missing proofs')
  return deserializeProofs(rawProofs as string[])
}

export function proofsFromPaymentProof(proof: GenericPaymentProof): Proof[] {
  return proofsFromPaymentProofParams(clearPaymentProofParams(proof))
}

export function proofAmount(proofs: Proof[]): bigint {
  return BigInt(sumProofs(proofs).toString())
}

export async function proofStates(wallet: Wallet, proofs: Proof[]) {
  return wallet.checkProofsStates(proofs)
}

export function everyProofUnspent(states: Array<{ state: string }>): boolean {
  return states.every(state => state.state === CheckStateEnum.UNSPENT)
}

export function anyProofPending(states: Array<{ state: string }>): boolean {
  return states.some(state => state.state === CheckStateEnum.PENDING)
}
