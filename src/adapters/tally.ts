import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface TallyCompany {
  externalId: string;
  name: string;
}
export interface TallyStockItem {
  externalId: string;
  name: string;
  unit: string;
  physical: number | null;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
type XmlObject = Record<string, unknown>;

/** This installation initially talks only to the Tally listener on this machine. */
export function validateTallyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid local Tally URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Tally must use an HTTP or HTTPS loopback URL, without credentials, a path, query or fragment.',
    );
  }
  // Resolve the localhost label to a literal loopback address rather than trusting DNS.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString();
}

function xml(value: string): string {
  // XML 1.0 forbids these control characters; rejecting them is intentional.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw new Error('Tally identity contains unsupported control characters.');
  return value.replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );
}

function object(value: unknown): XmlObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlObject)
    : null;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const node = object(value);
  return node && typeof node['#text'] === 'string' ? node['#text'].trim() : '';
}

function required(value: unknown, label: string): string {
  const result = text(value);
  if (!result)
    throw new Error(`Tally returned a record without ${label}; existing data was retained.`);
  return result;
}

function hasFailure(value: unknown): boolean {
  const node = object(value);
  if (!node) return Array.isArray(value) && value.some(hasFailure);
  return Object.entries(node).some(
    ([key, child]) =>
      (['LINEERROR', 'ERROR', 'ERRORMSG', 'EXCEPTION'].includes(key) && text(child) !== '') ||
      hasFailure(child),
  );
}

function records(document: string, recordName: string): XmlObject[] {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(document))
    throw new Error('Tally returned unsupported XML declarations.');
  if (XMLValidator.validate(document) !== true)
    throw new Error('Tally returned malformed XML; existing data was retained.');
  let root: XmlObject | null;
  try {
    root = object(parser.parse(document));
  } catch {
    throw new Error('Tally XML could not be read.');
  }
  const envelope = object(root?.ENVELOPE);
  const header = object(envelope?.HEADER);
  if (!envelope || hasFailure(root) || text(header?.STATUS) === '0') {
    throw new Error('Tally rejected the read request or returned an unexpected response.');
  }
  const body = object(envelope.BODY);
  if (!body || !Object.hasOwn(body, 'DATA'))
    throw new Error('Tally response is missing its data envelope.');
  const data = object(body.DATA);
  // An explicit empty collection is valid. An unexplained empty DATA section is not.
  if (!data) throw new Error('Tally response is missing its collection.');
  let collection: XmlObject | null;
  if (Object.hasOwn(data, 'COLLECTION')) {
    if (data.COLLECTION === '') return [];
    collection = object(data.COLLECTION);
    if (!collection) throw new Error('Tally returned an ambiguous collection.');
  } else if (Object.hasOwn(data, recordName)) collection = data;
  else throw new Error('Tally response is missing the requested collection.');
  const children = collection[recordName];
  if (children === undefined) {
    if (Object.keys(collection).every((key) => key.startsWith('@_'))) return [];
    throw new Error('Tally response contains an unexpected collection.');
  }
  return (Array.isArray(children) ? children : [children]).map((value) => {
    const row = object(value);
    if (!row) throw new Error('Tally returned an invalid record.');
    return row;
  });
}

/** Unrecognised units and compound quantities stay unknown, never become zero. */
export function parseTallyQuantity(value: string, unit: string): number | null {
  const raw = value.trim();
  if (!raw || !unit.trim()) return null;
  // Accept plain digits and unambiguous Western/Indian grouped digits only.
  const match =
    /^([+-]?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?)(?:\s+(.+))?$/u.exec(raw);
  if (!match || (match[2] !== undefined && match[2].trim() !== unit.trim())) return null;
  const quantity = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(quantity) && Math.abs(quantity) <= Number.MAX_SAFE_INTEGER
    ? quantity
    : null;
}

function exportRequest(
  collection: string,
  type: string,
  fields: string,
  company?: TallyCompany,
): string {
  const today = new Date();
  const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const scope = company
    ? `<SVCURRENTCOMPANY>${xml(company.name)}</SVCURRENTCOMPANY><SVTODATE TYPE="Date">${date}</SVTODATE>`
    : '';
  // The projection permits checking the actual company context for every returned stock item.
  const projection = company
    ? '<METHOD>StockbridgeCompanyGuid : $GUID:Company:##SVCurrentCompany</METHOD>'
    : '';
  const methods = fields
    .split(',')
    .map((field) => `<NATIVEMETHOD>${field}</NATIVEMETHOD>`)
    .join('');
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${collection}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${scope}</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="${collection}" ISMODIFY="No"><TYPE>${type}</TYPE>${methods}${projection}</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export class TallyClient {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {
    this.baseUrl = validateTallyUrl(baseUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new Error('Invalid Tally timeout.');
  }

  private async read(request: string): Promise<string> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        body: request,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'application/xml, text/xml' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Tally returned HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error('Tally returned an empty response.');
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body.cancel();
        throw new Error('Tally response exceeds the size limit.');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error('Tally response exceeds the size limit.');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, size);
      const charset =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'utf-16le'
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? 'utf-16be'
            : 'utf-8';
      return new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
        throw new Error('Tally did not respond before the timeout; existing data was retained.', {
          cause: error,
        });
      }
      if (error instanceof TypeError)
        throw new Error(
          'Could not read Tally. Check that Tally is open and its local HTTP server is enabled.',
          { cause: error },
        );
      throw error;
    }
  }

  async listCompanies(): Promise<TallyCompany[]> {
    const document = await this.read(exportRequest('StockbridgeCompanies', 'Company', 'Name,GUID'));
    const companies = records(document, 'COMPANY').map((row) => ({
      externalId: required(row.GUID, 'a company GUID'),
      name: required(row.NAME ?? row['@_NAME'], 'a company name'),
    }));
    if (
      new Set(companies.map((company) => company.externalId)).size !== companies.length ||
      new Set(companies.map((company) => company.name)).size !== companies.length
    ) {
      throw new Error(
        'Tally returned duplicate company identities; choose an unambiguous loaded company.',
      );
    }
    return companies;
  }

  async readStock(company: TallyCompany): Promise<TallyStockItem[]> {
    if (!company.externalId.trim() || !company.name.trim())
      throw new Error('A verified Tally company is required.');
    const ensureIdentity = async () => {
      const companies = await this.listCompanies();
      if (
        !companies.some(
          (candidate) =>
            candidate.externalId === company.externalId && candidate.name === company.name,
        )
      ) {
        throw new Error(
          'The selected Tally company identity changed or is no longer loaded. Refresh companies before importing stock.',
        );
      }
    };
    await ensureIdentity();
    const document = await this.read(
      exportRequest(
        'StockbridgeStockItems',
        'StockItem',
        'Name,GUID,BaseUnits,ClosingBalance',
        company,
      ),
    );
    const items = records(document, 'STOCKITEM').map((row) => {
      if (required(row.STOCKBRIDGECOMPANYGUID, 'the stock company GUID') !== company.externalId) {
        throw new Error('Tally stock belongs to a different company; existing data was retained.');
      }
      const unit = text(row.BASEUNITS);
      return {
        externalId: required(row.GUID, 'a stock item GUID'),
        name: required(row.NAME ?? row['@_NAME'], 'a stock item name'),
        unit,
        physical: parseTallyQuantity(text(row.CLOSINGBALANCE), unit),
      };
    });
    if (new Set(items.map((item) => item.externalId)).size !== items.length)
      throw new Error('Tally returned duplicate stock item identities.');
    await ensureIdentity();
    return items;
  }
}
