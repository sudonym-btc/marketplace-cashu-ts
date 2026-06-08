import {
  CheckStateEnum,
  P2PKBuilder,
  deserializeProofs,
  parseP2PKSecret,
  serializeProofs,
  sumProofs,
  type P2PKTag,
  type Proof,
  type Wallet,
} from '@cashu/cashu-ts'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { CashuAmount, GenericPaymentProof } from '../types.js'
import { normalizePublicKey } from '../utils/hex.js'

export const cashuEscrowPolicyType = 'cashu:p2pk-escrow-v1' as const
export const cashuAuctionPolicyType = 'cashu:p2pk-auction-v1' as const

export type CashuP2pkPolicyType = typeof cashuEscrowPolicyType | typeof cashuAuctionPolicyType

export type CashuEscrowParticipants = {
  buyerPubkey: string
  sellerPubkey: string
  escrowPubkey: string
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
  message: string
  messageHash: string
  signerPubkey: string
  signature: string
  target: {
    tradeId: string
    settlementId: string
    locktime: number
    participants: CashuEscrowParticipants
    order?: Record<string, unknown>
  }
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
            escrowPubkey: normalizePublicKey(input.participants.escrowPubkey, 'escrow cashu pubkey'),
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
      normalizePublicKey(input.escrowPubkey, 'escrow cashu pubkey'),
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
      normalizePublicKey(input.escrowPubkey, 'escrow cashu pubkey'),
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
          normalizePublicKey(input.escrowPubkey, 'escrow cashu pubkey'),
        ]
      : [
          normalizePublicKey(input.buyerPubkey, 'buyer cashu pubkey'),
          normalizePublicKey(input.sellerPubkey, 'seller cashu pubkey'),
          normalizePublicKey(input.escrowPubkey, 'escrow cashu pubkey'),
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
  tradeId: string
  settlementId: string
  locktime: number
  participants: CashuEscrowParticipants
  order?: Record<string, unknown>
}): CashuRecycleArgs {
  const target = {
    tradeId: input.tradeId,
    settlementId: `${input.settlementId}:escrow`,
    locktime: input.locktime,
    participants: input.participants,
    ...(input.order && Object.keys(input.order).length > 0 ? { order: input.order } : {}),
  }
  const message = JSON.stringify({
    version: 1,
    type: 'cashu:p2pk-auction-promote-v1',
    fromPolicyType: cashuAuctionPolicyType,
    toPolicyType: cashuEscrowPolicyType,
    target,
  })
  const digest = sha256(new TextEncoder().encode(message))
  return {
    version: 1,
    type: 'cashu:p2pk-auction-promote-v1',
    fromPolicyType: cashuAuctionPolicyType,
    toPolicyType: cashuEscrowPolicyType,
    message,
    messageHash: `0x${bytesToHex(digest)}`,
    signerPubkey: normalizePublicKey(input.buyerPubkey, 'buyer cashu pubkey'),
    signature: bytesToHex(schnorr.sign(digest, hexToBytes(input.buyerPrivateKey))),
    target,
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
  return {
    method: 'cashu',
    params: {
      version: 1,
      policyType,
      policyHash: input.policyHash,
      conditionHash: input.conditionHash,
      ...(input.recycleArgs ? { recycleArgs: input.recycleArgs } : {}),
      mint: input.mintUrl,
      unit: input.unit,
      amount: input.amount.value.toString(),
      denomination: input.amount.denomination,
      decimals: input.amount.decimals,
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

export function proofsFromPaymentProof(proof: GenericPaymentProof): Proof[] {
  const rawProofs = proof.params.proofs
  if (!Array.isArray(rawProofs)) throw new Error('Cashu payment proof is missing proofs')
  return deserializeProofs(rawProofs as string[])
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
