export function saleDay(isoTime: string): string {
  // Flipkart seller dates and the reviewed Tally book dates use Indian standard time.
  return new Date(Date.parse(isoTime) + 330 * 60_000).toISOString().slice(0, 10);
}
