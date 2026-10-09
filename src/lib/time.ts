const two = (n: number) => String(n).padStart(2, "0");

/** Local time as HH:MM:SS. */
export function localHms(d: Date = new Date()): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
