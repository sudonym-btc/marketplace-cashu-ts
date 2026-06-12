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
import { isMarketplaceDriverEncryptedPaymentProofParams } from '@sudonym-btc/marketplace-driver-interface'

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
  return {
    driver: policyType,
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
