import { createApiRoot } from '../client/create.client.js';
import { createImportApiRoot } from '../client/create.import.client.js';
import { CsvFeedSource, CustomObjectFeedSource, type FeedBatch, type FeedSource } from '../services/feed.service.js';
import { acquireLock } from '../services/lock.service.js';
import { importPrices, planPriceKeys, reconcilePriceKeys, resolveKeys, type ResolvedKeys } from '../services/price-import.service.js';
import { priceKeyFor } from '../services/feed.service.js';
import { isUnchanged, readLastRun, recordLastRun } from '../services/run-state.service.js';
import { readConfiguration, type Configuration } from '../utils/config.utils.js';
import { logger } from '../utils/logger.utils.js';

/**
 * The nightly price feed: a CSV file → the Import API, on a cron schedule.
 *
 * Connect's scheduler triggers it with a `POST` to the application's endpoint (see ../index.ts); locally,
 * `npm run once` runs it from the command line.
 *
 * A Job application has no HTTP surface and no caller. Nobody is watching it, so LOGS ARE THE ONLY
 * EVIDENCE it ran — and its natural failure mode is silence. This one therefore reports every row and
 * logs every failure at ERROR (including rows the file itself got wrong), and reports the run as
 * `failed`, so a bad night shows up red in the deployment log instead of looking exactly like a good one.
 *
 * It is storefront-agnostic: it writes prices to the project, and every client — a custom BFF, the
 * Commerce Integration Layer, the Merchant Center — reads them from there.
 */
function feedSourceFor(config: Configuration, apiRoot: ReturnType<typeof createApiRoot>): FeedSource {
  if (config.feedSource === 'custom-object') {
    return new CustomObjectFeedSource(apiRoot, config.feedContainer, config.feedKey);
  }
  return new CsvFeedSource(config.feedUrl!, {
    ...(config.feedAuthHeader ? { authHeader: config.feedAuthHeader } : {}),
    timeoutSeconds: config.feedTimeoutSeconds,
    maxBytes: config.maxFeedBytes,
  });
}

export interface RunOutcome {
  /** `ok` = everything imported (or nothing to do); `failed` = at least one row failed or was rejected. */
  status: 'ok' | 'failed' | 'skipped';
  reason?: string;
  imported?: number;
  failed?: number;
  pending?: number;
}

export async function runPriceFeed(): Promise<RunOutcome> {
  const started = Date.now();
  const config = readConfiguration();
  const apiRoot = createApiRoot();

  const lock = await acquireLock(apiRoot, config.feedContainer, config.lockStaleMinutes);
  if (!lock) {
    // Not a failure: the previous run is still going. Exit 0 — a red deployment log should mean
    // something is wrong, not that the schedule is tighter than the work.
    logger.info('Skipped: another run is in progress');
    return { status: 'skipped', reason: 'another run is in progress' };
  }

  try {
    const feed = await feedSourceFor(config, apiRoot).read();
    for (const r of feed.rejected) logger.error('Feed row rejected', { line: r.line, reason: r.reason, raw: r.raw });

    if (feed.rows.length === 0) return nothingToImport(feed, started);

    if (config.skipUnchangedFeed && !config.dryRun) {
      const unchanged = await skipIfUnchanged(apiRoot, config.feedContainer, feed);
      if (unchanged) return unchanged;
    }

    const keys = await resolveKeys(apiRoot, [...new Set(feed.rows.map((r) => r.sku))]);

    if (config.dryRun) return dryRunOutcome(feed, keys);

    // Keys first: an unkeyed price in a row's scope would make the import ADD a duplicate (DuplicatePriceScope).
    const importKeys = await reconcilePriceKeys(apiRoot, feed.rows, keys);

    const result = await importPrices(createImportApiRoot(), config.importContainerKey, feed.rows, keys, {
      timeoutSeconds: config.pollTimeoutSeconds,
      intervalSeconds: config.pollIntervalSeconds,
    }, importKeys);

    logSettledRows(result.rows);
    const failed = result.failed + feed.rejected.length;
    logger.info('Price feed finished', {
      source: feed.source,
      containerKey: result.containerKey,
      total: result.total + feed.rejected.length,
      imported: result.imported,
      failed,
      pending: result.pending,
      durationMs: Date.now() - started,
    });

    await recordLastRun(apiRoot, config.feedContainer, {
      fingerprint: feed.fingerprint,
      source: feed.source,
      finishedAt: new Date().toISOString(),
      imported: result.imported,
      // Pending rows count as not-yet-successful, so tomorrow retries an identical file.
      failed: failed + result.pending,
    });

    return { status: failed > 0 ? 'failed' : 'ok', imported: result.imported, failed, pending: result.pending };
  } finally {
    await lock.release();
  }
}

function nothingToImport(feed: FeedBatch, started: number): RunOutcome {
  logger.info('Nothing to import', { source: feed.source, rejected: feed.rejected.length, durationMs: Date.now() - started });
  return feed.rejected.length > 0
    ? { status: 'failed', reason: 'every row in the feed was rejected', failed: feed.rejected.length }
    : { status: 'ok', reason: 'nothing to import', imported: 0, failed: 0 };
}

async function skipIfUnchanged(
  apiRoot: ReturnType<typeof createApiRoot>,
  feedContainer: string,
  feed: FeedBatch
): Promise<RunOutcome | undefined> {
  const last = await readLastRun(apiRoot, feedContainer);
  if (!isUnchanged(last, feed.fingerprint)) return undefined;
  logger.info('Skipped: the feed is unchanged since the last successful import', {
    source: feed.source,
    lastImportAt: last!.finishedAt,
  });
  return { status: 'skipped', reason: 'feed unchanged since the last successful import' };
}

function dryRunOutcome(feed: FeedBatch, keys: Map<string, ResolvedKeys>): RunOutcome {
  const unknown = feed.rows.filter((r) => !keys.has(r.sku)).map((r) => r.sku);
  const plan = planPriceKeys(feed.rows, keys);
  const stamps = [...plan.values()].filter((p) => p.stamp).length;
  const creates = [...plan].filter(([feedKey, p]) => !p.stamp && p.importKey === feedKey
    && !keys.get(feed.rows.find((r) => priceKeyFor(r) === feedKey)!.sku)?.prices?.some((x) => x.key === feedKey)).length;
  logger.info('Dry run: nothing submitted', {
    source: feed.source,
    rows: feed.rows.length,
    resolvable: feed.rows.length - unknown.length,
    unknownSkus: [...new Set(unknown)],
    rejected: feed.rejected.length,
    wouldUpdate: plan.size - stamps - creates,
    wouldStampKeyThenUpdate: stamps,
    wouldCreate: creates,
  });
  return {
    status: unknown.length > 0 || feed.rejected.length > 0 ? 'failed' : 'ok',
    reason: 'dry run — nothing submitted',
    failed: unknown.length + feed.rejected.length,
  };
}

function logSettledRows(rows: Array<{ sku: string; priceKey: string; state: string; errors: unknown[] }>): void {
  for (const row of rows) {
    const context = { sku: row.sku, priceKey: row.priceKey, state: row.state, errors: row.errors };
    if (row.errors.length > 0) logger.error('Row failed', context);
    else logger.info('Row settled', context);
  }
}
