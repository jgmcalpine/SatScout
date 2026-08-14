export function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function safeAdd(left: number, right: number): number | undefined {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    return undefined;
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    return undefined;
  }
  return sum;
}
