/** Keep minor-unit amounts exact, including values larger than JavaScript's safe integer. */
export function purchaseAmount(total: string, minorUnit: number) {
  const digits = total.padStart(minorUnit + 1, "0");
  return minorUnit ? `${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}` : digits;
}
