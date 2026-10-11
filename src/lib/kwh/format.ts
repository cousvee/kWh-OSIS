/** 20000 -> "Rp20.000" */
export function formatRupiah(amount: number): string {
  const n = Math.trunc(amount);
  const sign = n < 0 ? "-" : "";
  return sign + "Rp" + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
