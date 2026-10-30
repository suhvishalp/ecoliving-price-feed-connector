import type { ByProjectKeyRequestBuilder as ImportApiRoot } from '@commercetools/importapi-sdk';
import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk';
import { logger } from '../utils/logger.utils.js';
import { priceKeyFor, type FeedRow } from './feed.service.js';

/** The Import API accepts at most 20 resources per request. */
export const MAX_ROWS_PER_REQUEST = 20;

export interface RowOutcome {
  sku: string;
  priceKey: string;
  state: string;
  errors: string[];
}

export interface ImportReport {
  containerKey: string;
  total: number;
  imported: number;
  failed: number;
  pending: number;
  rows: RowOutcome[];
}

const TERMINAL_FAILURE = new Set(['validationFailed', 'rejected', 'canceled']);

/**
 * Resolve each SKU to the KEYS the Import API identifies by.
 *
 * The Import API does not know about SKUs: a PriceImport names its product and variant by `key`, and
 * upserts the price by the price's own `key`. Get this wrong and the import silently ADDS prices the
 * storefront never selects, instead of updating the ones it shows.
 */
export interface ResolvedKeys {
  productKey: string;
  variantKey: string;
  /** For key reconciliation (below): the product to update and the variant's CURRENT prices. */
  productId?: string;
  version?: number;
  prices?: ExistingPrice[];
}

export interface ExistingPrice {
  id: string;
  key?: string;
  currencyCode: string;
  country?: string;
  /** Any of these set = a different scope (channel / group / validity / recurrence) — never the feed's. */
  scoped?: boolean;
}

export async function resolveKeys(
  apiRoot: ByProjectKeyRequestBuilder,
  skus: string[]
): Promise<Map<string, ResolvedKeys>> {
  const resolved = new Map<string, ResolvedKeys>();
  if (skus.length === 0) return resolved;

  const { body } = await apiRoot
    .productProjections()
    .get({
      queryArgs: {
        where: `masterVariant(sku in (${skus.map(quote).join(',')})) or variants(sku in (${skus.map(quote).join(',')}))`,
        limit: 500,
      },
    })
    .execute();

  for (const product of body.results) {
    if (!product.key) continue;
    for (const variant of [product.masterVariant, ...(product.variants ?? [])]) {
      if (variant?.sku && skus.includes(variant.sku)) {
        // The seeder stamps variant key = SKU; fall back to that convention when the key is absent.
        resolved.set(variant.sku, {
          productKey: product.key,
          variantKey: variant.key ?? variant.sku,
          productId: product.id,
          version: product.version,
          prices: (variant.prices ?? []).map((p) => ({
            id: p.id,
            key: p.key,
            currencyCode: p.value.currencyCode,
            country: p.country,
            scoped: Boolean(p.channel || p.customerGroup || p.validFrom || p.validUntil || p.recurrencePolicy),
          })),
        });
      }
    }
  }
  return resolved;
}

/**
 * The Import API upserts a price BY KEY and never by scope: a key it does not know is a CREATE, and a second
 * price in an existing scope (currency + country) is refused with DuplicatePriceScope. So for every row, decide
 * which key the import must use: an existing keyed price in the row's scope → its key, whatever it is; an existing
 * unkeyed one → the feed's key, stamped on it first (`setPriceKey` — the Import API cannot set keys); no price in
 * that scope → the feed's key, and the import creates it. Pure: `reconcilePriceKeys` performs the stamps.
 */
export interface KeyPlan {
  importKey: string;
  stamp?: { productId: string; version: number; priceId: string; key: string };
}

export function planPriceKeys(rows: FeedRow[], keys: Map<string, ResolvedKeys>): Map<string, KeyPlan> {
  const plan = new Map<string, KeyPlan>();
  for (const row of rows) {
    const feedKey = priceKeyFor(row);
    const resolved = keys.get(row.sku);
    const existing = resolved?.prices?.find(
      (p) => !p.scoped && p.currencyCode === row.currencyCode && (p.country ?? null) === (row.country ?? null)
    );
    if (!existing) plan.set(feedKey, { importKey: feedKey });
    else if (existing.key) plan.set(feedKey, { importKey: existing.key });
    else if (resolved?.productId && resolved.version !== undefined)
      plan.set(feedKey, { importKey: feedKey, stamp: { productId: resolved.productId, version: resolved.version, priceId: existing.id, key: feedKey } });
    else plan.set(feedKey, { importKey: feedKey });
  }
  return plan;
}

/** Perform the plan's stamps (one product update each, current side) and return feed key → import key. */
export async function reconcilePriceKeys(
  apiRoot: ByProjectKeyRequestBuilder,
  rows: FeedRow[],
  keys: Map<string, ResolvedKeys>
): Promise<Map<string, string>> {
  const plan = planPriceKeys(rows, keys);
  // A product's version moves with every stamp; keep our own counter per product so several rows of one product
  // (EUR-DE, GBP-GB, …) do not race each other with a stale version.
  const versions = new Map<string, number>();
  for (const [feedKey, p] of plan) {
    if (!p.stamp) continue;
    const version = versions.get(p.stamp.productId) ?? p.stamp.version;
    const { body } = await apiRoot
      .products()
      .withId({ ID: p.stamp.productId })
      .post({ body: { version, actions: [{ action: 'setPriceKey', priceId: p.stamp.priceId, key: p.stamp.key, staged: false }] } })
      .execute();
    versions.set(p.stamp.productId, body.version);
    logger.info('Stamped a key on an unkeyed price so the feed updates it instead of adding a duplicate', {
      priceKey: feedKey,
      productId: p.stamp.productId,
    });
  }
  return new Map([...plan].map(([feedKey, p]) => [feedKey, p.importKey]));
}

/** Submit the feed in batches, then poll until every operation settles (or the budget runs out). */
export async function importPrices(
  importApiRoot: ImportApiRoot,
  containerKey: string,
  rows: FeedRow[],
  keys: Map<string, { productKey: string; variantKey: string }>,
  poll: { timeoutSeconds: number; intervalSeconds: number; sleep?: (ms: number) => Promise<void> },
  /** feed key → the key the import must use (from `reconcilePriceKeys`); absent = the feed's key. */
  importKeys?: Map<string, string>
): Promise<ImportReport> {
  const unresolved: RowOutcome[] = [];
  const submittable: FeedRow[] = [];

  for (const row of rows) {
    if (keys.has(row.sku)) submittable.push(row);
    else
      unresolved.push({
        sku: row.sku,
        priceKey: priceKeyFor(row),
        state: 'validationFailed',
        errors: [`No product variant with SKU ${row.sku} exists in this Project.`],
      });
  }

  const submittedIds = new Set<string>();
  for (const batch of chunk(submittable, MAX_ROWS_PER_REQUEST)) {
    const resources = batch.map((row) => {
      const key = keys.get(row.sku)!;
      return {
        key: importKeys?.get(priceKeyFor(row)) ?? priceKeyFor(row),
        product: { typeId: 'product' as const, key: key.productKey },
        productVariant: { typeId: 'product-variant' as const, key: key.variantKey },
        value: {
          type: 'centPrecision' as const,
          currencyCode: row.currencyCode,
          centAmount: row.centAmount,
        },
        ...(row.country ? { country: row.country } : {}),
        // false writes the CURRENT projection, which is what the storefront reads. Omitting this
        // stages the change and the PLP never sees it — a silent no-op that looks like success.
        staged: false,
      };
    });

    const { body } = await importApiRoot
      .prices()
      .importContainers()
      .withImportContainerKeyValue({ importContainerKey: containerKey })
      .post({ body: { type: 'price', resources } })
      .execute();
    // The response names the ImportOperations THIS request created. Poll only those: the container
    // also holds every earlier run's operations for the same price keys.
    for (const op of (body as { operationStatus?: Array<{ operationId?: string }> })?.operationStatus ?? []) {
      if (op.operationId) submittedIds.add(op.operationId);
    }
    logger.info('Batch submitted', { containerKey, rows: resources.length });
  }

  // A 2xx from the Import API is an ACKNOWLEDGEMENT, not a result: the work happens asynchronously and
  // the ImportOperations carry the outcome. A job that stops at the 2xx reports success it cannot know.
  const settled = await pollOperations(importApiRoot, containerKey, submittable.map(priceKeyFor), poll, submittedIds);
  return report(containerKey, [...unresolved, ...settled]);
}

async function pollOperations(
  importApiRoot: ImportApiRoot,
  containerKey: string,
  expectedKeys: string[],
  poll: { timeoutSeconds: number; intervalSeconds: number; sleep?: (ms: number) => Promise<void> },
  submittedIds: Set<string> = new Set()
): Promise<RowOutcome[]> {
  if (expectedKeys.length === 0) return [];
  const sleep = poll.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + poll.timeoutSeconds * 1000;
  let outcomes: RowOutcome[] = [];

  for (;;) {
    const { body } = await importApiRoot
      .importContainers()
      .withImportContainerKeyValue({ importContainerKey: containerKey })
      .importOperations()
      .get({ queryArgs: { limit: 200 } })
      .execute();

    outcomes = body.results
      .filter((op) => op.resourceKey && expectedKeys.includes(op.resourceKey))
      // This run's operations only, when the Import API told us their ids; otherwise fall back to keys.
      .filter((op) => submittedIds.size === 0 || submittedIds.has(op.id))
      .map((op) => ({
        sku: skuFromPriceKey(op.resourceKey),
        priceKey: op.resourceKey,
        state: String(op.state),
        errors: (op.errors ?? []).map((e) => e.message ?? String(e.code)),
      }));

    const stillRunning = outcomes.filter((o) => o.state === 'processing' || o.state === 'unresolved');
    if (outcomes.length >= expectedKeys.length && stillRunning.length === 0) return outcomes;
    if (Date.now() >= deadline) {
      logger.warn('Poll budget exhausted; reporting what has settled', {
        settled: outcomes.length - stillRunning.length,
        stillRunning: stillRunning.length,
      });
      return outcomes;
    }
    await sleep(poll.intervalSeconds * 1000);
  }
}

export function report(containerKey: string, rows: RowOutcome[]): ImportReport {
  const imported = rows.filter((r) => r.state === 'imported').length;
  const failed = rows.filter((r) => TERMINAL_FAILURE.has(r.state)).length;
  return { containerKey, total: rows.length, imported, failed, pending: rows.length - imported - failed, rows };
}

/** `CARM-023-EUR-DE` -> `CARM-023`. Drops the currency, and the country when one is present. */
export function skuFromPriceKey(key: string): string {
  const parts = key.split('-');
  const drop = parts.length >= 3 && parts[parts.length - 1]!.length === 2 ? 2 : 1;
  return parts.length <= drop ? key : parts.slice(0, parts.length - drop).join('-');
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
