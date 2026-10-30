import { describe, expect, it, vi } from 'vitest';
import {
  chunk, importPrices, MAX_ROWS_PER_REQUEST, report, skuFromPriceKey,
} from '../src/services/price-import.service.js';
import { priceKeyFor, type FeedRow } from '../src/services/feed.service.js';

describe('the feed key convention — what the Import API upserts on', () => {
  it('builds the key the seeder stamped onto the catalogue prices', () => {
    expect(priceKeyFor({ sku: 'CARM-023', currencyCode: 'EUR', centAmount: 1 })).toBe('CARM-023-EUR');
    expect(priceKeyFor({ sku: 'CARM-023', currencyCode: 'EUR', centAmount: 1, country: 'DE' })).toBe('CARM-023-EUR-DE');
  });

  it('recovers the SKU from a price key, with or without a country', () => {
    expect(skuFromPriceKey('CARM-023-EUR')).toBe('CARM-023');
    expect(skuFromPriceKey('CARM-023-EUR-DE')).toBe('CARM-023');
    expect(skuFromPriceKey('LPC-011-GBP')).toBe('LPC-011');
  });
});

describe('batching', () => {
  it('never exceeds the Import API limit of 20 resources per request', () => {
    const batches = chunk(Array.from({ length: 45 }, (_, i) => i), MAX_ROWS_PER_REQUEST);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
  });
});

function importApiRootWith(operations: Array<{ resourceKey: string; state: string; errors?: unknown[] }>) {
  const post = vi.fn(() => ({ execute: async () => ({ body: {} }) }));
  const opsGet = vi.fn(() => ({ execute: async () => ({ body: { results: operations } }) }));
  return {
    root: {
      prices: () => ({
        importContainers: () => ({ withImportContainerKeyValue: () => ({ post }) }),
      }),
      importContainers: () => ({
        withImportContainerKeyValue: () => ({ importOperations: () => ({ get: opsGet }) }),
      }),
    } as never,
    post,
  };
}

const ROW: FeedRow = { sku: 'CARM-023', currencyCode: 'EUR', centAmount: 44900, country: 'DE' };
const KEYS = new Map([['CARM-023', { productKey: 'charlie-armchair', variantKey: 'CARM-023' }]]);
const POLL = { timeoutSeconds: 1, intervalSeconds: 0, sleep: async () => {} };

describe('importing', () => {
  it('submits a PriceImport keyed by product/variant KEY, not SKU, writing the current projection', async () => {
    const h = importApiRootWith([{ resourceKey: 'CARM-023-EUR-DE', state: 'imported' }]);
    await importPrices(h.root, 'lhc-price-feed', [ROW], KEYS, POLL);

    const body = h.post.mock.calls[0]![0]!.body;
    expect(body.type).toBe('price');
    expect(body.resources[0]).toMatchObject({
      key: 'CARM-023-EUR-DE',
      product: { typeId: 'product', key: 'charlie-armchair' },
      productVariant: { typeId: 'product-variant', key: 'CARM-023' },
      country: 'DE',
      // staged:false writes the CURRENT projection — the one the storefront reads. Omitting it makes
      // the whole import a silent no-op as far as the PLP is concerned.
      staged: false,
    });
    expect(body.resources[0].value).toMatchObject({ currencyCode: 'EUR', centAmount: 44900 });
  });

  it('reports an unresolvable SKU as a failed row without submitting it', async () => {
    const h = importApiRootWith([]);
    const result = await importPrices(h.root, 'c', [{ sku: 'NOPE', currencyCode: 'EUR', centAmount: 1 }], new Map(), POLL);
    expect(h.post).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(result.rows[0]!.errors[0]).toContain('No product variant with SKU NOPE');
  });

  it('waits for the operations to settle rather than trusting the 2xx acknowledgement', async () => {
    const h = importApiRootWith([{ resourceKey: 'CARM-023-EUR-DE', state: 'imported' }]);
    const result = await importPrices(h.root, 'c', [ROW], KEYS, POLL);
    expect(result).toMatchObject({ total: 1, imported: 1, failed: 0, pending: 0 });
  });

  it('surfaces a validation failure with its message', async () => {
    const h = importApiRootWith([
      { resourceKey: 'CARM-023-EUR-DE', state: 'validationFailed', errors: [{ message: 'bad price' }] },
    ]);
    const result = await importPrices(h.root, 'c', [ROW], KEYS, POLL);
    expect(result.failed).toBe(1);
    expect(result.rows[0]!.errors).toEqual(['bad price']);
  });

  it('gives up politely when operations never settle, reporting them as pending', async () => {
    const h = importApiRootWith([{ resourceKey: 'CARM-023-EUR-DE', state: 'processing' }]);
    const result = await importPrices(h.root, 'c', [ROW], KEYS, POLL);
    expect(result.pending).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe('the report drives the exit code', () => {
  it('counts terminal failures separately from work still in flight', () => {
    const r = report('c', [
      { sku: 'a', priceKey: 'a-EUR', state: 'imported', errors: [] },
      { sku: 'b', priceKey: 'b-EUR', state: 'rejected', errors: ['boom'] },
      { sku: 'c', priceKey: 'c-EUR', state: 'processing', errors: [] },
    ]);
    expect(r).toMatchObject({ total: 3, imported: 1, failed: 1, pending: 1 });
  });
});

describe('reporting only this run', () => {
  it('ignores earlier runs’ operations for the same keys when the Import API returns operation ids', async () => {
    const post = vi.fn(() => ({ execute: async () => ({ body: { operationStatus: [{ operationId: 'op-new', state: 'processing' }] } }) }));
    const opsGet = vi.fn(() => ({ execute: async () => ({ body: { results: [
      { id: 'op-old', resourceKey: 'CARM-023-EUR-DE', state: 'imported' },   // yesterday's run, same key
      { id: 'op-new', resourceKey: 'CARM-023-EUR-DE', state: 'imported' },   // this run
    ] } }) }));
    const root = {
      prices: () => ({ importContainers: () => ({ withImportContainerKeyValue: () => ({ post }) }) }),
      importContainers: () => ({ withImportContainerKeyValue: () => ({ importOperations: () => ({ get: opsGet }) }) }),
    } as never;
    const r = await importPrices(root, 'lhc-price-feed', [ROW], KEYS, POLL);
    expect(r.total).toBe(1);
    expect(r.imported).toBe(1);
  });
});

describe('price-key reconciliation (the DuplicatePriceScope guard)', () => {
  const row = { sku: 'CARM-023', currencyCode: 'EUR', centAmount: 44900, country: 'DE' };
  const base = { productKey: 'charlie-armchair', variantKey: 'CARM-023', productId: 'prod-1', version: 7 };

  it('uses the existing price key in the row scope, whatever it is', async () => {
    const { planPriceKeys } = await import('../src/services/price-import.service.js');
    const plan = planPriceKeys([row], new Map([['CARM-023', { ...base, prices: [{ id: 'p1', key: 'legacy-eur-de', currencyCode: 'EUR', country: 'DE' }] }]]));
    expect(plan.get('CARM-023-EUR-DE')).toEqual({ importKey: 'legacy-eur-de' });
  });

  it('stamps the feed key on an unkeyed price in the scope before importing', async () => {
    const { planPriceKeys } = await import('../src/services/price-import.service.js');
    const plan = planPriceKeys([row], new Map([['CARM-023', { ...base, prices: [{ id: 'p1', currencyCode: 'EUR', country: 'DE' }, { id: 'p2', key: 'x', currencyCode: 'GBP', country: 'GB' }] }]]));
    expect(plan.get('CARM-023-EUR-DE')).toEqual({ importKey: 'CARM-023-EUR-DE', stamp: { productId: 'prod-1', version: 7, priceId: 'p1', key: 'CARM-023-EUR-DE' } });
  });

  it('ignores channel / group / validity scoped prices and creates when the scope is free', async () => {
    const { planPriceKeys } = await import('../src/services/price-import.service.js');
    const plan = planPriceKeys([row], new Map([['CARM-023', { ...base, prices: [{ id: 'p1', currencyCode: 'EUR', country: 'DE', scoped: true }] }]]));
    expect(plan.get('CARM-023-EUR-DE')).toEqual({ importKey: 'CARM-023-EUR-DE' });
  });

  it('importPrices uses the reconciled key', async () => {
    const h = importApiRootWith([{ resourceKey: 'legacy-eur-de', state: 'imported' }]);
    await importPrices(h.root, 'c', [row], new Map([['CARM-023', base]]), POLL, new Map([['CARM-023-EUR-DE', 'legacy-eur-de']]));
    const body = (h.post.mock.calls[0] as unknown as [{ body: { resources: Array<{ key: string }> } }])[0].body;
    expect(body.resources[0]!.key).toBe('legacy-eur-de');
  });
});
