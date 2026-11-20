/** The launcher and its live runtime must agree on the exact loopback destination. */
export function liveDashboardPort(value = process.env.STOCKBRIDGE_DASHBOARD_PORT): number {
  if (value === undefined) return 4310;
  const port = Number(value);
  if (!/^[1-9]\d{0,4}$/.test(value) || port > 65535)
    throw new Error('STOCKBRIDGE_DASHBOARD_PORT must be a port number from 1 to 65535.');
  return port;
}
