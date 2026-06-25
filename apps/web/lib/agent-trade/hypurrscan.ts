export function normalizeHypurrscanAddress(address?: string | null): `0x${string}` | null {
  if (!address || !/^0x[0-9a-fA-F]{40}$/u.test(address)) {
    return null;
  }
  return address.toLowerCase() as `0x${string}`;
}

export function hypurrscanAddressUrl(address?: string | null): string | null {
  const normalized = normalizeHypurrscanAddress(address);
  return normalized ? `https://hypurrscan.io/address/${normalized}` : null;
}
