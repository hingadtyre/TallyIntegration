/** Account-scoped order evidence for reviewing Tally sales bills. */
export interface FlipkartBillingOrder {
  orderItemId: string;
  orderId: string;
  invoiceNumber: string | null;
  listingId: string;
  sku: string;
  locationId: string;
  quantity: number;
  orderDate: string;
  eligibilityUnverified?: true;
  /** Present on stock reads when the order is cancelled or needs stock review. */
  stockDisposition?: 'cancelled' | 'uncertain';
  /** Local reconciliation found conflicting identities on successive stock reads. */
  stockIdentityConflict?: true;
  /** Dispatch or return evidence conflicts with a later claim of an unshipped cancellation. */
  stockDispatchObserved?: true;
  /** A physical return or seller cancellation needs the seller to reconcile available stock. */
  stockReconciliationRequired?: true;
}

interface ShipmentLine {
  order: FlipkartBillingOrder;
  shipmentId: string;
  invoiceEligible: boolean;
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
const postDispatch = ['PICKUP_COMPLETE', 'SHIPPED', 'DELIVERED', 'COMPLETED'];
const saleStatuses = new Set([...preDispatch, ...postDispatch]);
const invoiceStatuses = new Set(['PACKED', 'READY_TO_DISPATCH', ...postDispatch]);
const excludedStatuses = new Set(['RETURN_REQUESTED', 'RETURNED', 'CANCELLED']);

export class FlipkartBillingError extends Error {}
class ShipmentSearchLimit extends FlipkartBillingError {}

const maximumWindow = 31 * 86_400_000;

interface ShipmentFilter {
  type: 'preDispatch' | 'postDispatch' | 'cancelled';
  states: string[];
  shipmentTypes: string[];
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

function collectShipment(
  value: unknown,
  earliest: number,
  latest: number,
  lines: Map<string, ShipmentLine>,
  excluded: Set<string>,
  stockFilter?: ShipmentFilter,
): void {
  const shipment = record(value);
  const shipmentId = identifier(shipment.shipmentId);
  const locationId = identifier(shipment.locationId);
  if (!Array.isArray(shipment.orderItems) || !shipment.orderItems.length) incomplete();
  if (
    stockFilter &&
    ((shipment.shipmentType &&
      !stockFilter.shipmentTypes.includes(String(shipment.shipmentType))) ||
      (stockFilter.hold !== undefined &&
        typeof shipment.hold === 'boolean' &&
        shipment.hold !== stockFilter.hold))
  )
    incomplete();
  for (const raw of shipment.orderItems) {
    const item = record(raw);
    const id = identifier(item.orderItemId);
    const status = typeof item.status === 'string' ? item.status : '';
    const replacement = item.is_replacement ?? item.isReplacement;
    const returnAddOn =
      stockFilter &&
      Array.isArray(item.add_ons) &&
      item.add_ons.some((addOn: unknown) => record(addOn).is_rto === true);
    const returnEvidence =
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
    if (!stockFilter && exceptional) {
      excluded.add(id);
      lines.delete(id);
      continue;
    }
    // Optional flags in Flipkart's response have no documented false default.
    // Keep otherwise identified lines visible for review if classification is incomplete.
    let eligibilityUnverified =
      shipment.hold !== false ||
      replacement !== false ||
      item.courierReturn !== false ||
      !saleStatuses.has(status);
    if (excluded.has(id)) continue;
    if (
      item.serviceProfile &&
      !['NON_FBF', 'Seller_Fulfilment'].includes(String(item.serviceProfile))
    ) {
      if (stockFilter) incomplete();
      continue;
    }
    if (shipment.shipmentType && !['NORMAL', 'SELF'].includes(String(shipment.shipmentType)))
      continue;
    const date = sellerTimestamp(item.orderDate);
    if (date < earliest || date > latest) continue;
    if (
      typeof item.quantity !== 'number' ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0
    )
      incomplete();
    let disposition: FlipkartBillingOrder['stockDisposition'];
    if (stockFilter) {
      const knownScope = Boolean(item.serviceProfile && shipment.shipmentType);
      // Cancellation in the forward fulfilment flow precedes shipping. In-transit
      // cancellations use the returns flow. Seller cancellations can indicate a shortage.
      if (
        knownScope &&
        stockFilter.type === 'cancelled' &&
        stockFilter.cancellationType !== 'sellerCancellation' &&
        status === 'CANCELLED' &&
        item.cancellationDate &&
        sellerTimestamp(item.cancellationDate) >= date &&
        shipment.hold === false &&
        replacement === false &&
        item.isReplacement !== true &&
        item.is_replacement !== true &&
        item.courierReturn === false &&
        !returnAddOn
      )
        disposition = 'cancelled';
      else if (exceptional || eligibilityUnverified || !knownScope) disposition = 'uncertain';
      eligibilityUnverified = disposition === 'uncertain';
    }
    const order: FlipkartBillingOrder = {
      orderItemId: id,
      orderId: identifier(item.orderId),
      invoiceNumber: null,
      listingId: identifier(item.listingId),
      sku: identifier(item.sku),
      locationId,
      quantity: item.quantity,
      orderDate: new Date(date).toISOString(),
      ...(eligibilityUnverified && { eligibilityUnverified: true }),
      ...(disposition && { stockDisposition: disposition }),
      ...(stockFilter &&
        (postDispatch.includes(status) || returnEvidence) && { stockDispatchObserved: true }),
      ...(stockFilter &&
        (returnEvidence ||
          (stockFilter.cancellationType === 'sellerCancellation' && status === 'CANCELLED')) && {
          stockReconciliationRequired: true,
        }),
    };
    rememberLine(
      lines,
      { order, shipmentId, invoiceEligible: invoiceStatuses.has(status) },
      Boolean(stockFilter),
    );
  }
}

function rememberLine(
  lines: Map<string, ShipmentLine>,
  line: ShipmentLine,
  forStock: boolean,
): void {
  const { order, shipmentId } = line;
  const previous = lines.get(order.orderItemId);
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
  if (forStock && previous && previous.order.stockDisposition !== order.stockDisposition) {
    order.stockDisposition = 'uncertain';
    order.eligibilityUnverified = true;
  }
  if (previous?.order.stockDispatchObserved) order.stockDispatchObserved = true;
  if (previous?.order.stockReconciliationRequired) order.stockReconciliationRequired = true;
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
      ['postDispatch', postDispatch],
    ] as const) {
      for (const shipmentType of ['NORMAL', 'SELF']) {
        const filter = { type, states, shipmentTypes: [shipmentType] };
        for await (const shipment of this.search(token, filter, earliest, latest))
          collectShipment(shipment, earliest, latest, lines, excluded);
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
    verifyToken(token);
    const earliest = Date.parse(from);
    const latest = Date.parse(to);
    if (!Number.isFinite(earliest) || !Number.isFinite(latest) || earliest > latest)
      throw new FlipkartBillingError('Choose a valid Flipkart stock history period.');
    const lines = new Map<string, ShipmentLine>();
    // Adjacent windows overlap at the exact cutoff. Exact order-item IDs remove duplicates.
    let start = earliest;
    for (;;) {
      const end = Math.min(latest, start + maximumWindow);
      for (const shipmentType of ['NORMAL', 'SELF']) {
        const shipmentTypes = [shipmentType];
        const filters: ShipmentFilter[] = [
          { type: 'preDispatch', states: preDispatch, shipmentTypes, hold: true },
          { type: 'preDispatch', states: preDispatch, shipmentTypes, hold: false },
          {
            type: 'postDispatch',
            states: [...postDispatch, 'RETURN_REQUESTED', 'RETURNED'],
            shipmentTypes,
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
            cancellationType,
          });
        for (const filter of filters) await this.readStockWindow(token, filter, start, end, lines);
      }
      if (end === latest) break;
      start = end;
    }
    if (includeInvoices) await this.addInvoiceNumbers(token, lines);
    return Array.from(lines.values(), (line) => line.order);
  }

  private async readStockWindow(
    token: string,
    filter: ShipmentFilter,
    earliest: number,
    latest: number,
    collected: Map<string, ShipmentLine>,
  ): Promise<void> {
    const lines = new Map<string, ShipmentLine>();
    const excluded = new Set<string>();
    try {
      for await (const shipment of this.search(token, filter, earliest, latest))
        collectShipment(shipment, earliest, latest, lines, excluded, filter);
    } catch (error) {
      if (!(error instanceof ShipmentSearchLimit)) throw error;
      const middle = earliest + Math.floor((latest - earliest) / 2);
      if (middle === earliest)
        throw new FlipkartBillingError(
          'Flipkart could not return complete stock history at its search limit.',
        );
      const recovered = new Map<string, ShipmentLine>();
      await this.readStockWindow(token, filter, earliest, middle, recovered);
      await this.readStockWindow(token, filter, middle, latest, recovered);
      // A change during pagination can remove a known order from a renewed search.
      // Preserve every positive observation and never accept a disappearing cancellation.
      for (const line of lines.values()) {
        if (!recovered.has(line.order.orderItemId)) {
          line.order.stockDisposition = 'uncertain';
          line.order.eligibilityUnverified = true;
        }
        rememberLine(recovered, line, true);
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
  ): AsyncGenerator<unknown> {
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
              filter: { ...filter, serviceProfiles: ['NON_FBF'], orderDate },
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
      yield* page.shipments;
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

  private async addInvoiceNumbers(token: string, lines: Map<string, ShipmentLine>): Promise<void> {
    const shipmentIds = [
      ...new Set(
        Array.from(lines.values())
          .filter((row) => row.invoiceEligible)
          .map((row) => row.shipmentId),
      ),
    ];
    for (let start = 0; start < shipmentIds.length; start += 25) {
      const batch = shipmentIds.slice(start, start + 25);
      if (batch.some((id) => !/^[A-Za-z0-9_-]+$/u.test(id))) incomplete();
      const url = 'https://api.flipkart.net/sellers/v3/shipments/' + batch.join(',') + '/invoices';
      const result = await this.request(token, url, undefined, true);
      if (!result) continue;
      if (result.invoices == null) continue;
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
          const line = lines.get(identifier(record(raw).orderItemId));
          if (!line) continue; // A shipment can also contain a held or excluded line.
          if (
            line.shipmentId !== shipmentId ||
            (line.order.invoiceNumber && line.order.invoiceNumber !== number)
          )
            incomplete();
          line.order.invoiceNumber = number;
        }
      }
    }
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
        if (
          invoice &&
          ([404, 406, 415].includes(response.status) || (response.ok && mime === 'application/pdf'))
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
