import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { normalizeHex } from './utils/hex.js'

const curveOrder = secp256k1.Point.Fn.ORDER

function uint32Bytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid index: ${value}`)
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function privateKeyFromDigest(digest: Uint8Array): Uint8Array {
  const scalar = (BigInt(`0x${bytesToHex(digest)}`) % (curveOrder - 1n)) + 1n
  return hexToBytes(scalar.toString(16).padStart(64, '0'))
}

export type CashuDerivedKey = {
  privateKey: string
  publicKey: string
}

export function deriveCashuEscrowKey(
  seed: string,
  input: {
    accountIndex: number
    role: 'buyer' | 'settlement' | 'fee'
    keyIndex?: number
  },
): CashuDerivedKey {
  const seedBytes = hexToBytes(normalizeHex(seed, 'marketplace seed', 32))
  const digest = sha256(concat(
    utf8('marketplace-cashu-escrow-v1'),
    seedBytes,
    uint32Bytes(input.accountIndex),
    utf8(input.role),
    uint32Bytes(input.keyIndex ?? 0),
  ))
  const privateKey = privateKeyFromDigest(digest)
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(secp256k1.getPublicKey(privateKey, true)),
  }
}
