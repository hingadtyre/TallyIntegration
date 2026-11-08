import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { TallyClient, parseTallyQuantity, validateTallyUrl } from '../../src/adapters/tally.js';

const company = { externalId: 'company-a-guid', name: 'A & B Tyres' };
const companyXml = '<COMPANY><NAME>A &amp; B Tyres</NAME><GUID>company-a-guid</GUID></COMPANY>';
const envelope = (content: string) =>
  `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${content}</COLLECTION></DATA></BODY></ENVELOPE>`;
const stockXml = (quantity = '4 nos', guid = company.externalId) =>
  `<STOCKITEM NAME="A tyre"><GUID>stock-guid</GUID><BASEUNITS>nos</BASEUNITS><CLOSINGBALANCE>${quantity}</CLOSINGBALANCE><STOCKBRIDGECOMPANYGUID>${guid}</STOCKBRIDGECOMPANYGUID></STOCKITEM>`;

async function withServer(
  handler: (body: string, response: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.match(request.headers['content-type'] ?? '', /^text\/xml/);
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.match(body, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
    assert.doesNotMatch(body, /<TALLYREQUEST>(?:Import|Execute)/);
    handler(body, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('company discovery returns every loaded company with its stable identity', async () => {
  await withServer(
    (_body, response) =>
      response.end(
        envelope(
          companyXml + '<COMPANY NAME="Second company"><GUID>company-b-guid</GUID></COMPANY>',
        ),
      ),
    async (url) => {
      assert.deepEqual(await new TallyClient(url).listCompanies(), [
        company,
        { externalId: 'company-b-guid', name: 'Second company' },
      ]);
    },
  );
});

test('Tally requests are exports and stock is scoped and checked against the selected company', async () => {
  const requests: string[] = [];
  await withServer(
    (body, response) => {
      requests.push(body);
      response.end(envelope(body.includes('<TYPE>StockItem</TYPE>') ? stockXml() : companyXml));
    },
    async (url) => {
      const result = await new TallyClient(url).readStock(company);
      assert.deepEqual(result, [
        { externalId: 'stock-guid', name: 'A tyre', unit: 'nos', physical: 4 },
      ]);
    },
  );
  assert.equal(requests.length, 3);
  assert.match(requests[1], /<SVCURRENTCOMPANY>A &amp; B Tyres<\/SVCURRENTCOMPANY>/);
  assert.match(requests[1], /<SVTODATE TYPE="Date">\d{8}<\/SVTODATE>/);
  assert.match(requests[1], /StockbridgeCompanyGuid : \$GUID:Company:##SVCurrentCompany/);
  assert.match(requests[1], /<NATIVEMETHOD>ClosingBalance<\/NATIVEMETHOD>/);
  assert.match(requests[1], /<METHOD>StockbridgeCompanyGuid/);
});

test('stock reads retain distinct items and unsupported quantities remain unknown', async () => {
  const stockItems =
    stockXml('-3.5 nos') + stockXml('1 box = 4 nos').replace('stock-guid', 'compound-stock-guid');
  await withServer(
    (body, response) =>
      response.end(envelope(body.includes('<TYPE>StockItem</TYPE>') ? stockItems : companyXml)),
    async (url) => {
      assert.deepEqual(await new TallyClient(url).readStock(company), [
        { externalId: 'stock-guid', name: 'A tyre', unit: 'nos', physical: -3.5 },
        { externalId: 'compound-stock-guid', name: 'A tyre', unit: 'nos', physical: null },
      ]);
    },
  );
});

test('unsupported quantity stays unknown; negative and grouped base units are retained', () => {
  assert.equal(parseTallyQuantity('1,200 nos', 'nos'), 1200);
  assert.equal(parseTallyQuantity('1,25,000 nos', 'nos'), 125000);
  assert.equal(parseTallyQuantity('-3.5 kg', 'kg'), -3.5);
  assert.equal(parseTallyQuantity('0 nos', 'nos'), 0);
  assert.equal(parseTallyQuantity('4', 'nos'), 4);
  for (const value of [
    '',
    '4 pairs',
    '1 box = 4 nos',
    'NaN',
    '1,2 nos',
    'Infinity',
    '4 nos extra',
  ]) {
    assert.equal(parseTallyQuantity(value, 'nos'), null, value);
  }
  assert.equal(parseTallyQuantity('4', ''), null);
});

test('missing stable identities and wrong company context reject the whole import', async () => {
  await withServer(
    (_body, response) => response.end(envelope('<COMPANY NAME="A &amp; B Tyres"/>')),
    async (url) => {
      await assert.rejects(new TallyClient(url).listCompanies(), /company GUID/);
    },
  );
  await withServer(
    (body, response) =>
      response.end(
        envelope(
          body.includes('<TYPE>StockItem</TYPE>')
            ? stockXml('4 nos', 'different-company')
            : companyXml,
        ),
      ),
    async (url) => {
      await assert.rejects(new TallyClient(url).readStock(company), /different company/);
    },
  );
});

test('company identity changing during a read rejects the result', async () => {
  let companyReads = 0;
  await withServer(
    (body, response) => {
      const stock = body.includes('<TYPE>StockItem</TYPE>');
      if (!stock) companyReads++;
      response.end(
        envelope(
          stock
            ? stockXml()
            : companyReads === 1
              ? companyXml
              : companyXml.replace('company-a-guid', 'new-company-guid'),
        ),
      );
    },
    async (url) => {
      await assert.rejects(new TallyClient(url).readStock(company), /identity changed/);
    },
  );
});

test('a selected company that is no longer loaded blocks the stock export', async () => {
  const requests: string[] = [];
  await withServer(
    (body, response) => {
      requests.push(body);
      response.end(envelope(companyXml.replace('company-a-guid', 'other-company-guid')));
    },
    async (url) => {
      await assert.rejects(new TallyClient(url).readStock(company), /no longer loaded/);
    },
  );
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0], /<TYPE>StockItem<\/TYPE>/);
});

test('duplicate company identities and stock item GUIDs reject the entire read', async () => {
  for (const duplicateCompany of [
    companyXml.replace('A &amp; B Tyres', 'Another company'),
    companyXml.replace('company-a-guid', 'another-company-guid'),
  ]) {
    await withServer(
      (_body, response) => response.end(envelope(companyXml + duplicateCompany)),
      async (url) => {
        await assert.rejects(new TallyClient(url).listCompanies(), /duplicate company identities/);
      },
    );
  }
  await withServer(
    (body, response) =>
      response.end(
        envelope(body.includes('<TYPE>StockItem</TYPE>') ? stockXml() + stockXml() : companyXml),
      ),
    async (url) => {
      await assert.rejects(
        new TallyClient(url).readStock(company),
        /duplicate stock item identities/,
      );
    },
  );
});

test('explicit empty collections are accepted without treating a missing payload as empty inventory', async () => {
  await withServer(
    (_body, response) => response.end(envelope('')),
    async (url) => {
      assert.deepEqual(await new TallyClient(url).listCompanies(), []);
    },
  );
  await withServer(
    (body, response) =>
      response.end(envelope(body.includes('<TYPE>StockItem</TYPE>') ? '' : companyXml)),
    async (url) => {
      assert.deepEqual(await new TallyClient(url).readStock(company), []);
    },
  );
  await withServer(
    (_body, response) => response.end('<ENVELOPE><BODY><DATA/></BODY></ENVELOPE>'),
    async (url) => {
      await assert.rejects(new TallyClient(url).listCompanies(), /missing its collection/);
    },
  );
});

test('malformed XML, Tally errors and entity declarations never become an empty successful import', async () => {
  for (const document of [
    '<ENVELOPE>',
    '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>',
    envelope('<LINEERROR>Failed</LINEERROR>'),
    '<!DOCTYPE ENVELOPE [<!ENTITY private SYSTEM "file:///private">]><ENVELOPE/>',
  ]) {
    await withServer(
      (_body, response) => response.end(document),
      async (url) => {
        await assert.rejects(new TallyClient(url).listCompanies(), /Tally/);
      },
    );
  }
});

test('HTTP failures and timeouts reject the read', async () => {
  await withServer(
    (_body, response) => {
      response.writeHead(503);
      response.end();
    },
    async (url) => {
      await assert.rejects(new TallyClient(url).listCompanies(), /HTTP 503/);
    },
  );
  await withServer(
    () => {},
    async (url) => {
      await assert.rejects(new TallyClient(url, 30).listCompanies(), /timeout/);
    },
  );
});

test('redirects are not followed and remote URLs are rejected before connecting', async () => {
  await withServer(
    (_body, response) => {
      response.writeHead(302, { Location: 'http://example.com' });
      response.end();
    },
    async (url) => {
      await assert.rejects(new TallyClient(url).listCompanies(), /Could not read Tally/);
    },
  );
  assert.equal(validateTallyUrl('http://localhost:9000'), 'http://127.0.0.1:9000/');
  for (const url of [
    'http://example.com:9000',
    'file:///tmp/a',
    'http://user:secret@127.0.0.1:9000',
    'http://127.0.0.1:9000/path',
    'http://127.0.0.1:9000?x=1',
  ]) {
    assert.throws(() => validateTallyUrl(url), /Tally/);
  }
});

test('UTF-16 with a BOM is decoded and oversized responses are rejected', async () => {
  await withServer(
    (_body, response) => response.end(Buffer.from('\ufeff' + envelope(companyXml), 'utf16le')),
    async (url) => {
      assert.deepEqual(await new TallyClient(url).listCompanies(), [company]);
    },
  );
  await withServer(
    (_body, response) => {
      response.writeHead(200, { 'Content-Length': 17 * 1024 * 1024 });
      response.end();
    },
    async (url) => {
      await assert.rejects(new TallyClient(url).listCompanies(), /size limit/);
    },
  );
});
