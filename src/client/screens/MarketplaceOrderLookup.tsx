import { useEffect, useRef, useState } from 'react';
import type { BillingFulfilment, MarketplaceOrderLookup } from '../../shared/billing-contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { formatIndiaDay, formatUnits } from '../format.js';

export const fulfilmentLabels: Record<BillingFulfilment, string> = {
  standard: 'Standard',
  selfShip: 'Self-ship',
  express: 'Express',
  smart: 'Smart',
  fbf: 'Fulfilment by Flipkart',
};

const indiaTime = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export function indiaTimestamp(value: string) {
  return indiaTime.format(new Date(value)) + ' (India)';
}

export function marketplaceStatusLabel(status?: string | null, held?: boolean) {
  const words = status?.replaceAll('_', ' ').toLowerCase();
  const label = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Status unavailable';
  return held ? 'On hold · ' + label : label;
}

type LookupScope = { companyId: string; accountId: string; orderId: string };

function useLookup<T>(path: string, scope: LookupScope & { locationId?: string }) {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function lookup() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const data = await requestJson<T>(path, scope, controller.signal);
      if (!controller.signal.aborted) setResult(data);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      request.current = null;
    }
  }
  return { result, busy, error, lookup };
}

export function ExactOrderLookup(scope: LookupScope) {
  const { result, busy, error, lookup } = useLookup<MarketplaceOrderLookup>(
    '/billing/lookup-order',
    scope,
  );
  return (
    <div className="exact-order-lookup">
      {result ? (
        <>
          <h3>Flipkart order {result.orderId}</h3>
          <p>Checked {indiaTimestamp(result.checkedAt)}</p>
          {!result.items.length ? (
            <p>Flipkart returned no items for this exact order ID and seller.</p>
          ) : (
            <>
              <ul className="billing-order-details">
                {result.items.map((item) => (
                  <li key={item.orderItemId}>
                    <strong>{item.orderItemId}</strong> ·{' '}
                    {marketplaceStatusLabel(item.marketplaceStatus, item.marketplaceHold)}
                    <br />
                    {item.sku} · {formatUnits(item.quantity, 'listing')} · Ordered{' '}
                    {formatIndiaDay(item.orderDate)}
                    {item.fulfilment && ' · ' + fulfilmentLabels[item.fulfilment]}
                    {item.shipmentId && (
                      <>
                        <br />
                        Shipment {item.shipmentId}
                      </>
                    )}
                    <br />
                    {item.locationId
                      ? 'Pickup location ' + item.locationId
                      : 'Pickup location unavailable'}
                  </li>
                ))}
              </ul>
              <p>
                This lookup shows Flipkart’s order details. Tracked refreshes check bills and
                reservations.
              </p>
              {[...new Set(result.items.map((item) => item.locationId))].map(
                (locationId) =>
                  locationId && (
                    <PickupCount key={locationId} scope={scope} locationId={locationId} />
                  ),
              )}
            </>
          )}
        </>
      ) : (
        <>
          <p>If you have the full Flipkart order ID, check it directly for this seller.</p>
          <button className="button secondary" onClick={() => void lookup()} disabled={busy}>
            {busy ? 'Checking Flipkart order…' : 'Check exact order on Flipkart'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function PickupCount({ scope, locationId }: { scope: LookupScope; locationId: string }) {
  const { result, busy, error, lookup } = useLookup<{ shipmentCount: number; checkedAt: string }>(
    '/billing/pickup-count',
    { ...scope, locationId },
  );
  return (
    <div>
      {result ? (
        <p>
          {result.shipmentCount} {result.shipmentCount === 1 ? 'shipment' : 'shipments'} awaiting
          handover for this seller at {locationId} · Checked {indiaTimestamp(result.checkedAt)}
        </p>
      ) : (
        <button className="text-button" disabled={busy} onClick={() => void lookup()}>
          {busy
            ? 'Checking pickup workload…'
            : 'Check shipments awaiting handover at ' + locationId}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
