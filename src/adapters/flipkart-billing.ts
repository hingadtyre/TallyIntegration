import type { BillingFulfilment } from '../shared/billing-contracts.js';

/** Account-scoped order evidence for reviewing Tally sales bills. */
export interface FlipkartBillingOrder {
  orderItemId: string;
  orderId: string;
  invoiceNumber: string | null;
  /** Present when an invoice lookup was attempted and did not supply a number. */
  invoiceLookup?: 'failed' | 'no-number' | 'unsupported-format';
  listingId: string;
  sku: string;
  locationId: string;
  quantity: number;
  orderDate: string;
  eligibilityUnverified?: true;
  /** This pre-dispatch observation qualified despite an absent courier-return flag. */
  preDispatchWithoutCourierReturn?: true;
  /** Present on stock reads when the order is cancelled or needs stock review. */
  stockDisposition?: 'cancelled' | 'uncertain';
  /** Local reconciliation found conflicting identities on successive stock reads. */
  stockIdentityConflict?: true;
  /** Dispatch or return evidence conflicts with a later claim of an unshipped cancellation. */
  stockDispatchObserved?: true;
  /** A return, seller cancellation or contradictory dispatch history requires reconciliation. */
  stockReconciliationRequired?: true;
  /** Exact shipment returned by a stock search, when recorded by this reader. */
  stockShipmentId?: string;
  /** Search and detail agreed on stock identity but disagreed about a cancellation and return. */
  stockReturnConflict?: true;
}

interface ShipmentLine {
  order: FlipkartBillingOrder;
  shipmentId: string;
  invoiceEligible: boolean;
  dispatchObserved: boolean;
}

const searchUrl = 'https://api.flipkart.net/sellers/v3/shipments/filter';
const maximumBytes = 2 * 1024 * 1024;
const preDispatch = [
  'APPROVED',
  'PACKING_IN_PROGRESS',
  'FORM_FAILED',
  'PACKED',
  'READY_TO_DISPATCH',
];
const postDispatchSearchStates = ['PICKUP_COMPLETE', 'SHIPPED', 'DELIVERED'];
const postDispatch = [...postDispatchSearchStates, 'COMPLETED'];
const billingPostDispatchStates = [...postDispatch, 'RETURN_REQUESTED', 'RETURNED'];
const saleStatuses = new Set([...preDispatch, ...postDispatch]);
const invoiceStatuses = new Set(['PACKED', 'READY_TO_DISPATCH', ...postDispatch]);
const excludedStatuses = new Set(['RETURN_REQUESTED', 'RETURNED', 'CANCELLED']);
const profileNames = {
  NON_FBF: new Set(['NON_FBF', 'Seller_Fulfilment']),
  FBF_LITE: new Set(['FBF_LITE', 'Smart_Fulfilment']),
  FBF: new Set(['FBF', 'Flipkart_Fulfilment']),
};
type ServiceProfile = keyof typeof profileNames;

interface ShipmentScope {
  serviceProfile: ServiceProfile;
  shipmentTypes: string[];
}

// Smart and FBF describe the fulfilment profile, regardless of shipment type.
// Express here is an EXPRESS shipment, independent of the dispatch service tier.
const billingScopes: Record<BillingFulfilment, ShipmentScope> = {
  standard: { serviceProfile: 'NON_FBF', shipmentTypes: ['NORMAL'] },
  selfShip: { serviceProfile: 'NON_FBF', shipmentTypes: ['SELF'] },
  express: { serviceProfile: 'NON_FBF', shipmentTypes: ['EXPRESS'] },
  smart: { serviceProfile: 'FBF_LITE', shipmentTypes: ['NORMAL', 'SELF', 'EXPRESS'] },
  fbf: { serviceProfile: 'FBF', shipmentTypes: ['NORMAL', 'SELF', 'EXPRESS'] },
};

export class FlipkartBillingError extends Error {}
class ShipmentSearchLimit extends FlipkartBillingError {}

const maximumWindow = 31 * 86_400_000;

interface ShipmentFilter {
  type: 'preDispatch' | 'postDispatch' | 'cancelled';
  states: string[];
  shipmentTypes: string[];
  serviceProfiles: [ServiceProfile];
  hold?: boolean;
  cancellationType?: 'buyerCancellation' | 'sellerCancellation' | 'marketplaceCancellation';
}

function verifyToken(token: string): void {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/u.test(token))
    throw new FlipkartBillingError('Verify the selected Flipkart account before reading orders.');
}

function incomplete(): never {
  throw new FlipkartBillingError(
    'Flipkart returned incomplete or inconsistent order evidence. Refresh the review.',
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) incomplete();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /\p{Cc}/u.test(value))
    incomplete();
  return value;
}

function nextPage(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) incomplete();
  const url = new URL(value, searchUrl);
  if (
    url.origin !== 'https://api.flipkart.net' ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/sellers\/v3\/shipments\/filter\/?$/u.test(url.pathname) ||
    !url.searchParams.get('next_token')
  )
    incomplete();
  return url.href;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get('content-length');
  if (
    !response.body ||
    (contentLength !== null &&
      (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes))
  ) {
    void response.body?.cancel().catch(() => {});
    incomplete();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        void reader.cancel().catch(() => {});
        incomplete();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function sellerTimestamp(value: unknown): number {
  const time = identifier(value);
  // Flipkart assumes IST when a seller date-time omits an offset.
  const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(time);
  const date = Date.parse(localTime ? time + '+05:30' : time);
  if (!Number.isFinite(date)) incomplete();
  return date;
}

function hasReturnAddOn(item: Record<string, unknown>): boolean | undefined {
  if (item.add_ons == null) return false;
  if (!Array.isArray(item.add_ons)) return undefined;
  const flags = item.add_ons.map((addOn: unknown) => record(addOn).is_rto);
  if (flags.includes(true)) return true;
  return flags.every((flag) => flag == null || flag === false) ? false : undefined;
}

/** Before dispatch the courier-return flag can be absent on an otherwise identified forward sale. */
function allowsMissingCourierReturn(
  shipment: Record<string, unknown>,
  item: Record<string, unknown>,
  filter: ShipmentFilter,
): boolean {
  return (
    item.courierReturn == null &&
    filter.type === 'preDispatch' &&
    typeof item.status === 'string' &&
    filter.states.includes(item.status) &&
    typeof shipment.shipmentType === 'string' &&
    filter.shipmentTypes.includes(shipment.shipmentType) &&
    typeof item.serviceProfile === 'string' &&
    profileNames.NON_FBF.has(item.serviceProfile) &&
    (shipment.shipmentType === 'NORMAL' || shipment.shipmentType === 'SELF') &&
    shipment.hold === false &&
    (item.is_replacement ?? item.isReplacement) === false &&
    (item.isReplacement == null || item.isReplacement === false) &&
    item.cancellationDate == null &&
    hasReturnAddOn(item) === false
  );
}

/** Details may omit optional search fields. Never take a location from contradictory evidence. */
function verifyLocationDetailLine(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  cancellationScopeConfirmed: boolean,
  missingCourierReturnAllowed: boolean,
  profiles: ReadonlySet<string>,
): boolean {
  const returnConflict =
    cancellationScopeConfirmed &&
    item.status === 'CANCELLED' &&
    (detail.status === 'RETURN_REQUESTED' || detail.status === 'RETURNED');
  if (
    returnConflict &&
    (['orderId', 'listingId', 'sku', 'quantity', 'orderDate'].some(
      (field) => detail[field] == null,
    ) ||
      !profiles.has(String(detail.serviceProfile)) ||
      !profiles.has(String(item.serviceProfile)) ||
      (detail.is_replacement ?? detail.isReplacement) !== false ||
      (item.is_replacement ?? item.isReplacement) !== false ||
      item.isReplacement === true ||
      item.is_replacement === true ||
      sellerTimestamp(item.cancellationDate) < sellerTimestamp(item.orderDate))
  )
    incomplete();
  if (!returnConflict && detail.status != null && detail.status !== item.status) incomplete();
  for (const field of ['orderId', 'listingId', 'sku', 'quantity']) {
    if (detail[field] != null && detail[field] !== item[field]) incomplete();
  }
  if (
    detail.courierReturn != null &&
    detail.courierReturn !== item.courierReturn &&
    !(missingCourierReturnAllowed && detail.courierReturn === false)
  )
    incomplete();
  for (const field of ['orderDate', 'cancellationDate']) {
    if (detail[field] != null && sellerTimestamp(detail[field]) !== sellerTimestamp(item[field]))
      incomplete();
  }
  const replacement = item.is_replacement ?? item.isReplacement;
  for (const flag of [detail.is_replacement, detail.isReplacement]) {
    if (flag != null && flag !== replacement) incomplete();
  }
  if (
    detail.serviceProfile != null &&
    detail.serviceProfile !== item.serviceProfile &&
    !(profiles.has(String(detail.serviceProfile)) && profiles.has(String(item.serviceProfile)))
  )
    incomplete();
  const detailReturn = hasReturnAddOn(detail);
  if (
    detailReturn === undefined ||
    (detailReturn && !hasReturnAddOn(item)) ||
    (missingCourierReturnAllowed && detailReturn !== false)
  )
    incomplete();
  return returnConflict;
}

interface ShipmentEvidence {
  shipment: Record<string, unknown>;
  returnConflicts?: Set<string>;
}

function collectShipment(
  { shipment, returnConflicts }: ShipmentEvidence,
  earliest: number,
  latest: number,
  lines: Map<string, ShipmentLine>,
  excluded: Set<string>,
  filter: ShipmentFilter,
  mode: 'stock' | 'billingHistory' | 'billing',
): void {
  const includeExceptions = mode !== 'billing';
  const shipmentId = identifier(shipment.shipmentId);
  // Billing can display an identified order even when its exact shipment details
  // have no pickup. A stock read still requires the location for this order.
  const locationId =
    mode === 'billingHistory' && shipment.locationId == null ? '' : identifier(shipment.locationId);
  if (!Array.isArray(shipment.orderItems) || !shipment.orderItems.length) incomplete();
  if (
    includeExceptions &&
    ((shipment.shipmentType && !filter.shipmentTypes.includes(String(shipment.shipmentType))) ||
      (filter.hold !== undefined &&
        typeof shipment.hold === 'boolean' &&
        shipment.hold !== filter.hold))
  )
    incomplete();
  for (const raw of shipment.orderItems) {
    const item = record(raw);
    const id = identifier(item.orderItemId);
    const status = typeof item.status === 'string' ? item.status : '';
    const replacement = item.is_replacement ?? item.isReplacement;
    const returnAddOn = hasReturnAddOn(item);
    const returnEvidence =
      returnConflicts?.has(id) ||
      status === 'RETURN_REQUESTED' ||
      status === 'RETURNED' ||
      item.courierReturn === true ||
      returnAddOn;
    const exceptional =
      shipment.hold === true ||
      excludedStatuses.has(status) ||
      item.cancellationDate ||
      item.is_replacement === true ||
      item.isReplacement === true ||
      item.courierReturn === true ||
      returnAddOn;
    const otherProfile =
      item.serviceProfile &&
      !profileNames[filter.serviceProfiles[0]].has(String(item.serviceProfile));
    const otherType =
      shipment.shipmentType && !['NORMAL', 'SELF'].includes(String(shipment.shipmentType));
    if (!includeExceptions && (exceptional || otherProfile || otherType)) {
      excluded.add(id);
      lines.delete(id);
      continue;
    }
    const preDispatchWithoutCourierReturn = allowsMissingCourierReturn(shipment, item, filter);
    let eligibilityUnverified =
      !locationId ||
      shipment.hold !== false ||
      replacement !== false ||
      returnAddOn === undefined ||
      (item.courierReturn !== false && !preDispatchWithoutCourierReturn) ||
      !saleStatuses.has(status);
    if (excluded.has(id)) continue;
    if (otherProfile) incomplete();
    const date = sellerTimestamp(item.orderDate);
    if (date < earliest || date > latest) continue;
    if (
      typeof item.quantity !== 'number' ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0
    )
      incomplete();
    let disposition: FlipkartBillingOrder['stockDisposition'];
    if (includeExceptions) {
      const knownScope =
        typeof item.serviceProfile === 'string' &&
        !!item.serviceProfile &&
        typeof shipment.shipmentType === 'string' &&
        !!shipment.shipmentType;
      // Cancellation in the forward fulfilment flow precedes shipping. In-transit
      // cancellations use the returns flow. Seller cancellations can indicate a shortage.
      if (
        knownScope &&
        !!locationId &&
        filter.type === 'cancelled' &&
        filter.cancellationType !== 'sellerCancellation' &&
        status === 'CANCELLED' &&
        item.cancellationDate &&
        sellerTimestamp(item.cancellationDate) >= date &&
        shipment.hold === false &&
        replacement === false &&
        item.isReplacement !== true &&
        item.is_replacement !== true &&
        item.courierReturn === false &&
        returnAddOn === false &&
        !returnEvidence
      )
        disposition = 'cancelled';
      else if (exceptional || eligibilityUnverified || !knownScope) disposition = 'uncertain';
      eligibilityUnverified = disposition === 'uncertain';
    }
    const dispatchObserved = Boolean(postDispatch.includes(status) || returnEvidence);
    const order: FlipkartBillingOrder = {
      orderItemId: id,
      orderId: identifier(item.orderId),
      invoiceNumber: null,
      listingId: identifier(item.listingId),
      sku: identifier(item.sku),
      locationId,
      quantity: item.quantity,
      orderDate: new Date(date).toISOString(),
      ...(preDispatchWithoutCourierReturn && { preDispatchWithoutCourierReturn: true }),
      ...(includeExceptions && { stockShipmentId: shipmentId }),
      ...(includeExceptions && returnConflicts?.has(id) && { stockReturnConflict: true }),
      ...(eligibilityUnverified && { eligibilityUnverified: true }),
      ...(disposition && { stockDisposition: disposition }),
      ...(includeExceptions && dispatchObserved && { stockDispatchObserved: true }),
      ...(includeExceptions &&
        (returnEvidence ||
          (filter.cancellationType === 'sellerCancellation' && status === 'CANCELLED')) && {
          stockReconciliationRequired: true,
        }),
    };
    rememberLine(
      lines,
      { order, shipmentId, invoiceEligible: invoiceStatuses.has(status), dispatchObserved },
      includeExceptions,
    );
  }
}

function rememberLine(
  lines: Map<string, ShipmentLine>,
  line: ShipmentLine,
  forStock: boolean,
  previous = lines.get(line.order.orderItemId),
): void {
  const { order, shipmentId } = line;
  if (
    previous &&
    (previous.shipmentId !== shipmentId ||
      previous.order.orderId !== order.orderId ||
      previous.order.listingId !== order.listingId ||
      previous.order.sku !== order.sku ||
      previous.order.quantity !== order.quantity ||
      previous.order.locationId !== order.locationId ||
      previous.order.orderDate !== order.orderDate)
  )
    incomplete();
  if (
    order.preDispatchWithoutCourierReturn &&
    (previous?.dispatchObserved || previous?.order.stockDisposition === 'cancelled')
  ) {
    order.eligibilityUnverified = true;
    if (forStock) {
      order.stockDisposition = 'uncertain';
      order.stockReconciliationRequired = true;
    }
  }
  if (previous?.dispatchObserved) line.dispatchObserved = true;
  if (forStock && previous && previous.order.stockDisposition !== order.stockDisposition) {
    order.stockDisposition = 'uncertain';
    order.eligibilityUnverified = true;
  }
  if (previous?.order.eligibilityUnverified) order.eligibilityUnverified = true;
  if (previous?.order.stockDispatchObserved) order.stockDispatchObserved = true;
  if (previous?.order.stockReconciliationRequired) order.stockReconciliationRequired = true;
  if (previous?.order.stockReturnConflict) order.stockReturnConflict = true;
  line.invoiceEligible =
    !order.stockDisposition &&
    !order.eligibilityUnverified &&
    (line.invoiceEligible || previous?.invoiceEligible === true);
  lines.set(order.orderItemId, line);
}

export class FlipkartBillingClient {
  constructor(private readonly options: { request?: typeof fetch } = {}) {}

  async readOrders(
    token: string,
    from: string,
    to: string,
    includeInvoices = false,
  ): Promise<FlipkartBillingOrder[]> {
    verifyToken(token);
    const earliest = Date.parse(from);
    const latest = Date.parse(to);
    if (
      !Number.isFinite(earliest) ||
      !Number.isFinite(latest) ||
      earliest > latest ||
      latest - earliest > maximumWindow
    )
      throw new FlipkartBillingError('Choose a Flipkart order review period of up to 31 days.');
    const lines = new Map<string, ShipmentLine>();
    const excluded = new Set<string>();
    for (const [type, states] of [
      ['preDispatch', preDispatch],
      ['postDispatch', postDispatchSearchStates],
    ] as const) {
      for (const shipmentType of ['NORMAL', 'SELF']) {
        const filter: ShipmentFilter = {
          type,
          states,
          shipmentTypes: [shipmentType],
          serviceProfiles: ['NON_FBF'],
        };
        for await (const evidence of this.search(token, filter, earliest, latest))
          collectShipment(evidence, earliest, latest, lines, excluded, filter, 'billing');
      }
    }
    if (includeInvoices) await this.addInvoiceNumbers(token, lines);
    return Array.from(lines.values(), (line) => line.order);
  }

  async readStockOrders(
    token: string,
    from: string,
    to: string,
    includeInvoices = false,
  ): Promise<FlipkartBillingOrder[]> {
    return this.readHistory(
      token,
      from,
      to,
      { serviceProfile: 'NON_FBF', shipmentTypes: ['NORMAL', 'SELF'] },
      includeInvoices,
      'stock',
    );
  }

  async readFulfilmentOrders(
    token: string,
    from: string,
    to: string,
    fulfilment: BillingFulfilment,
    includeInvoices = false,
  ): Promise<FlipkartBillingOrder[]> {
    return this.readHistory(
      token,
      from,
      to,
      billingScopes[fulfilment],
      includeInvoices,
      'billingHistory',
    );
  }

  private async readHistory(
    token: string,
    from: string,
    to: string,
    scope: ShipmentScope,
    includeInvoices: boolean,
    mode: 'stock' | 'billingHistory',
  ): Promise<FlipkartBillingOrder[]> {
    verifyToken(token);
    const earliest = Date.parse(from);
    const latest = Date.parse(to);
    if (!Number.isFinite(earliest) || !Number.isFinite(latest) || earliest > latest)
      throw new FlipkartBillingError('Choose a valid Flipkart order history period.');
    const lines = new Map<string, ShipmentLine>();
    // Adjacent windows overlap at the exact cutoff. Exact order-item IDs remove duplicates.
    let start = earliest;
    for (;;) {
      const end = Math.min(latest, start + maximumWindow);
      for (const shipmentType of scope.shipmentTypes) {
        const shipmentTypes = [shipmentType];
        const serviceProfiles: [ServiceProfile] = [scope.serviceProfile];
        const filters: ShipmentFilter[] = [
          { type: 'preDispatch', states: preDispatch, shipmentTypes, serviceProfiles, hold: true },
          { type: 'preDispatch', states: preDispatch, shipmentTypes, serviceProfiles, hold: false },
          {
            type: 'postDispatch',
            states:
              mode === 'billingHistory' ? billingPostDispatchStates : postDispatchSearchStates,
            shipmentTypes,
            serviceProfiles,
          },
        ];
        for (const cancellationType of [
          'buyerCancellation',
          'sellerCancellation',
          'marketplaceCancellation',
        ] as const)
          filters.push({
            type: 'cancelled',
            states: ['CANCELLED'],
            shipmentTypes,
            serviceProfiles,
            cancellationType,
          });
        for (const filter of filters)
          await this.readHistoryWindow(token, filter, start, end, lines, mode);
      }
      if (end === latest) break;
      start = end;
    }
    if (includeInvoices) await this.addInvoiceNumbers(token, lines, mode === 'billingHistory');
    return Array.from(lines.values(), (line) => line.order);
  }

  private async readHistoryWindow(
    token: string,
    filter: ShipmentFilter,
    earliest: number,
    latest: number,
    collected: Map<string, ShipmentLine>,
    mode: 'stock' | 'billingHistory',
  ): Promise<void> {
    const lines = new Map<string, ShipmentLine>();
    const excluded = new Set<string>();
    try {
      for await (const evidence of this.search(token, filter, earliest, latest))
        collectShipment(evidence, earliest, latest, lines, excluded, filter, mode);
    } catch (error) {
      if (!(error instanceof ShipmentSearchLimit)) throw error;
      const middle = earliest + Math.floor((latest - earliest) / 2);
      if (middle === earliest)
        throw new FlipkartBillingError(
          'Flipkart could not return complete order history at its search limit.',
        );
      const recovered = new Map<string, ShipmentLine>();
      await this.readHistoryWindow(token, filter, earliest, middle, recovered, mode);
      await this.readHistoryWindow(token, filter, middle, latest, recovered, mode);
      // A change during pagination can remove a known order from a renewed search.
      // Preserve every positive observation and never accept a disappearing cancellation.
      for (const line of lines.values()) {
        const later = recovered.get(line.order.orderItemId);
        if (later) {
          rememberLine(recovered, later, true, line);
        } else {
          line.order.stockDisposition = 'uncertain';
          line.order.eligibilityUnverified = true;
          rememberLine(recovered, line, true);
        }
      }
      for (const line of recovered.values()) rememberLine(collected, line, true);
      return;
    }
    for (const line of lines.values()) rememberLine(collected, line, true);
  }

  private async *search(
    token: string,
    filter: ShipmentFilter,
    earliest: number,
    latest: number,
  ): AsyncGenerator<ShipmentEvidence> {
    const orderDate = {
      from: new Date(earliest).toISOString(),
      to: new Date(latest).toISOString(),
    };
    let url = searchUrl;
    let pageCount = 0;
    let shipmentCount = 0;
    const seen = new Set<string>();
    for (;;) {
      const body =
        pageCount === 0
          ? {
              filter: { ...filter, orderDate },
              pagination: { pageSize: 20 },
            }
          : undefined;
      const page = await this.request(token, url, body);
      if (
        !page ||
        typeof page.hasMore !== 'boolean' ||
        !Array.isArray(page.shipments) ||
        page.shipments.length > 20 ||
        (page.hasMore && !page.shipments.length)
      )
        incomplete();
      shipmentCount += page.shipments.length;
      pageCount++;
      for (const value of page.shipments) {
        const shipment = record(value);
        yield shipment.locationId == null
          ? await this.withDispatchLocation(token, shipment, filter)
          : { shipment };
      }
      if (shipmentCount >= 5000 || pageCount > 250)
        throw new ShipmentSearchLimit(
          'This Flipkart search reached its result limit. Choose a shorter review period.',
        );
      if (!page.hasMore) break;
      try {
        url = nextPage(page.nextPageUrl);
      } catch {
        incomplete();
      }
      if (seen.has(url)) incomplete();
      seen.add(url);
    }
  }

  private async withDispatchLocation(
    token: string,
    shipment: Record<string, unknown>,
    filter: ShipmentFilter,
  ): Promise<ShipmentEvidence> {
    const id = identifier(shipment.shipmentId);
    const url = new URL('https://api.flipkart.net/sellers/v3/shipments');
    url.searchParams.set('shipmentIds', id);
    const result = await this.request(token, url.href);
    if (!Array.isArray(result?.shipments) || result.shipments.length !== 1) incomplete();
    const detail = record(result.shipments[0]);
    if (
      detail.shipmentId !== id ||
      (detail.shipmentType != null && detail.shipmentType !== shipment.shipmentType) ||
      (detail.hold != null && detail.hold !== shipment.hold) ||
      !Array.isArray(detail.orderItems) ||
      !Array.isArray(shipment.orderItems)
    )
      incomplete();
    const detailsByLine = new Map<string, Record<string, unknown>>();
    const returnConflicts = new Set<string>();
    const cancellationScopeConfirmed =
      filter.type === 'cancelled' &&
      filter.shipmentTypes.includes(String(shipment.shipmentType)) &&
      detail.shipmentType === shipment.shipmentType &&
      typeof detail.hold === 'boolean' &&
      detail.hold === shipment.hold;
    for (const raw of detail.orderItems) {
      const line = record(raw);
      const lineId = identifier(line.orderItemId);
      if (detailsByLine.has(lineId)) incomplete();
      detailsByLine.set(lineId, line);
    }
    for (const raw of shipment.orderItems) {
      const item = record(raw);
      const matching = detailsByLine.get(identifier(item.orderItemId));
      if (!matching) incomplete();
      if (
        verifyLocationDetailLine(
          item,
          matching,
          cancellationScopeConfirmed,
          allowsMissingCourierReturn(shipment, item, filter),
          profileNames[filter.serviceProfiles[0]],
        )
      )
        returnConflicts.add(identifier(item.orderItemId));
    }
    return {
      shipment: { ...shipment, locationId: detail.locationId },
      returnConflicts,
    };
  }

  private async addInvoiceNumbers(
    token: string,
    lines: Map<string, ShipmentLine>,
    retainOrdersOnError = false,
  ): Promise<void> {
    const eligible = new Map<string, FlipkartBillingOrder[]>();
    for (const { invoiceEligible, shipmentId, order } of lines.values()) {
      if (!invoiceEligible) continue;
      const group = eligible.get(shipmentId);
      if (group) group.push(order);
      else eligible.set(shipmentId, [order]);
    }
    const shipmentIds = [...eligible.keys()];
    for (let start = 0; start < shipmentIds.length; start += 25) {
      const batch = shipmentIds.slice(start, start + 25);
      let numbers: Map<string, string> | null;
      let missingNumber: FlipkartBillingOrder['invoiceLookup'];
      try {
        numbers = await this.readInvoiceBatch(token, batch, lines);
        missingNumber = numbers === null ? 'unsupported-format' : 'no-number';
      } catch (cause) {
        if (!retainOrdersOnError || !(cause instanceof FlipkartBillingError)) throw cause;
        numbers = null;
        missingNumber = 'failed';
      }
      // Apply a batch only after validating all of its shipment and order identities.
      for (const [id, number] of numbers ?? []) lines.get(id)!.order.invoiceNumber = number;
      for (const id of batch)
        for (const order of eligible.get(id)!)
          if (!order.invoiceNumber) order.invoiceLookup = missingNumber;
    }
  }

  private async readInvoiceBatch(token: string, batch: string[], lines: Map<string, ShipmentLine>) {
    if (batch.some((id) => !/^[A-Za-z0-9_-]+$/u.test(id))) incomplete();
    const url = 'https://api.flipkart.net/sellers/v3/shipments/' + batch.join(',') + '/invoices';
    const result = await this.request(token, url, undefined, true);
    if (!result) return null;
    const numbers = new Map<string, string>();
    if (result.invoices == null) return numbers;
    const invoices = Array.isArray(result.invoices) ? result.invoices : [result.invoices];
    for (const value of invoices) {
      const invoice = record(value);
      const shipmentId = identifier(invoice.shipmentId);
      if (!batch.includes(shipmentId)) incomplete();
      const rawNumber = invoice.invoiceNumber ?? invoice.InvoiceNumber;
      if (rawNumber == null || invoice.orderItems == null) continue;
      if (!Array.isArray(invoice.orderItems)) incomplete();
      const number = identifier(rawNumber);
      if (invoice.InvoiceNumber !== undefined && invoice.InvoiceNumber !== number) incomplete();
      for (const raw of invoice.orderItems) {
        const id = identifier(record(raw).orderItemId);
        const line = lines.get(id);
        if (!line) continue; // A shipment can also contain a held or excluded line.
        if (line.shipmentId !== shipmentId || (numbers.has(id) && numbers.get(id) !== number))
          incomplete();
        numbers.set(id, number);
      }
    }
    return numbers;
  }

  private async request(
    token: string,
    url: string,
    body?: unknown,
    invoice = false,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await (this.options.request ?? fetch)(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        cache: 'no-store',
      });
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || mime !== 'application/json') {
        void response.body?.cancel().catch(() => {});
        if (invoice && response.status === 404) return {};
        if (
          invoice &&
          ([406, 415].includes(response.status) || (response.ok && mime === 'application/pdf'))
        )
          return null;
        if (response.status === 401 || response.status === 403)
          throw new FlipkartBillingError(
            'Flipkart rejected access to these seller orders or invoices. Verify the selected account and its order permissions.',
          );
        if (response.status === 429)
          throw new FlipkartBillingError(
            'Flipkart is limiting order requests. Wait before refreshing the billing review.',
          );
        throw new FlipkartBillingError(
          'Flipkart could not supply this billing review. Check the seller account and try again.',
        );
      }
      return await readJson(response);
    } catch (error) {
      if (error instanceof FlipkartBillingError) throw error;
      throw new FlipkartBillingError(
        'Could not read verified Flipkart billing data. Refresh the review.',
      );
    }
  }
}
