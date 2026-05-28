export function normalizeHex(value: string, label: string, bytes?: number): string {
  const normalized = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value
  const expectedLength = bytes === undefined ? undefined : bytes * 2
  if (!/^[a-fA-F0-9]+$/.test(normalized) || (expectedLength !== undefined && normalized.length !== expectedLength)) {
    throw new Error(`Invalid ${label}`)
  }
  return normalized.toLowerCase()
}

export function normalizePublicKey(value: string, label: string): string {
  const normalized = normalizeHex(value, label)
  if (/^(02|03)[a-f0-9]{64}$/.test(normalized)) return normalized
  if (/^[a-f0-9]{64}$/.test(normalized)) return normalized
  throw new Error(`Invalid ${label}`)
}
