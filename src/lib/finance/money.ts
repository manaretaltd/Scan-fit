// Arithmetic uses integer minor units (BigInt), never binary floating-point sums.
export function minor(value: string | number): bigint {
  const s = String(value);
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error("Use whole pennies");
  const negative = s.startsWith("-"),
    [whole, fraction = ""] = s.replace("-", "").split(".");
  return (
    (negative ? -1n : 1n) *
    (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")))
  );
}
export function decimal(value: bigint): string {
  const sign = value < 0n ? "-" : "",
    n = value < 0n ? -value : value;
  return `${sign}${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}
export const displayed = (value: bigint) => Number(decimal(value));
export const percentOf = (amount: bigint, basisPoints: bigint) =>
  (amount * basisPoints + 5000n) / 10000n;
