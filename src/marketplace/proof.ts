import {
  CheckStateEnum,
  P2PKBuilder,
  deserializeProofs,
  parseP2PKSecret,
  serializeProofs,
  sumProofs,
  type Proof,
  type Wallet,
} from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import type { CashuAmount, GenericPaymentProof } from '../types.js'
import { normalizePublicKey } from '../utils/hex.js'

export const cashuEscrowPolicyType = 'cashu:p2pk-escrow-v1' as const

export type CashuEscrowParticipants = {
  buyerPubkey: string
  sellerPubkey: string
  escrowPubkey: string
}

export type CashuEscrowPolicyInput = CashuEscrowParticipants & {
  tradeId: string
  settlementId: string
  locktime: number
}

export function canonicalCashuAssetId(mintUrl: string, unit: string): string {
  return `cashu:${unit}:${mintUrl}`
}

export function cashuEscrowPolicyHash(input: {
  mintUrl: string
  unit: string
  locktime?: number
  participants?: CashuEscrowParticipants
}): string {
  const payload = JSON.stringify({
    type: cashuEscrowPolicyType,
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
    .addTags([
      ['marketplace', 'escrow'],
      ['trade', input.tradeId],
      ['settlement', input.settlementId],
      ['policy', cashuEscrowPolicyType],
    ])
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
    const expectedKeys = [
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
    if (!refund.includes(normalizePublicKey(input.sellerPubkey, 'seller cashu refund pubkey'))) return false
    const tradeId = tags.find(tag => tag[0] === 'trade')?.[1]
    if (tradeId !== input.tradeId) return false
    const settlementId = tags.find(tag => tag[0] === 'settlement')?.[1]
    if (settlementId !== input.settlementId) return false
    return true
  } catch {
    return false
  }
}

export function cashuPaymentProof(input: {
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
}): GenericPaymentProof {
  return {
    method: 'cashu',
    params: {
      version: 1,
      policyType: cashuEscrowPolicyType,
      policyHash: input.policyHash,
      conditionHash: input.conditionHash,
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
