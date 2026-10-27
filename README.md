# LHC Price-Feed Connector: commercetools Connect *(Import API, on a schedule)*

> **Installing it in Merchant Center?** Follow [INSTALL.md](INSTALL.md): the steps and the sample values for every setting.

One Connect **job** application: every night it reads a **CSV price file** and imports it through the
**Import API**. It's split out of the Sessions 8–9 connector ([`ecoliving-order-connectors`](https://github.com/commercetools/ecoliving-order-connectors)) so it can
be **installed on its own**, with its own least-privilege API client, on any project.

It is **storefront-agnostic**. It writes prices to the platform, and every client reads them from there.
That makes it the shared bulk-import piece for both tracks:

| Course | How it's used |
|---|---|
| **B2C Dev (BFF)** | Session 7 teaches the Import API call *inside* the BFF; Session 8.5 shows its production home, this job |
| **B2C Dev: CIL track** | Installed as-is: change a price in the CSV, run the job, see the new price in the CIL storefront. This is where CIL stops: bulk and scheduled work isn't shopper-facing, so it belongs in Connect |

| Folder | What |
|---|---|
| [`price-feed-job/`](price-feed-job/) | The `job` app (TypeScript, Express). The scheduler calls `POST /price-feed`; `GET /status` |
| [`samples/prices.csv`](samples/prices.csv) | The course feed: the six keyed demo prices (`charlie-armchair`, `luxe-pillow-cover`) at their current values |
| [`connect.yaml`](connect.yaml) | The deployment contract |

TypeScript only for now. A Java version of the same connector, for reference, comes later.

## Why this is a separate repository

Connect deploys a **GitHub repository at a git tag**, and **`connect.yaml` must be at the repository
root**. This connector is authored in the course build repo (`courses/b2c-dev/code/price-feed-connector/`) and synced
with `./sync-connector.sh <repo>`
to [`ecoliving-price-feed-connector`](https://github.com/commercetools/ecoliving-price-feed-connector), the same model as the Sessions 8–9 connector.

## The feed

```csv
sku,currency,country,amount
CARM-023,EUR,DE,449.00
```

- **Header row required**, names case-insensitive, any order, extra columns ignored. Aliases:
  `currencyCode` for `currency`, `price` for `amount`, or a `centAmount` column (integer minor units)
  instead of `amount`.
- `amount` is a **decimal in major units**, which is what ERPs export. It's converted *exactly* (string
  arithmetic, the currency's own fraction digits) to commercetools `centAmount`. Thousands separators,
  negatives and excess digits are rejected rather than guessed.
- `country` is optional (empty = every country).
- RFC 4180: BOM, CRLF, quoted fields with commas, quotes and line breaks.
- **Identity = the price key** `SKU-CURRENCY[-COUNTRY]`, the convention the seeder stamps. The Import API
  **upserts by key**, so a row *updates* the price the storefront shows. Without the key it would add a
  new price nobody selects.

| Where the file comes from | `FEED_URL` |
|---|---|
| The course | the raw `samples/prices.csv` of this connector's GitHub repo |
| Production | an S3 / Azure Blob / GCS object (pre-signed URLs work; the query string is never logged), or an SFTP-to-HTTPS gateway; `FEED_AUTH_HEADER` (secured) for a protected host |
| Local development | a file path, e.g. `../samples/prices.csv` |

## What a run does

1. **Lock.** A Custom Object compare-and-set, because the platform gives a job no concurrency guard. A
   stale lock (crashed run) is taken over after `LOCK_STALE_MINUTES`.
2. **Read and validate** the CSV. Every bad row is logged at ERROR **with its line number** and counted
   as failed, never silently dropped.
3. **Skip an unchanged file.** If the file's sha256 matches the last *fully successful* run, it stands
   down (`SKIP_UNCHANGED_FEED`). Re-importing is safe, just wasteful.
4. **Resolve** SKU → product key + variant key (the Import API doesn't know SKUs).
5. **Import** in batches of 20 (the Import API limit) with `staged: false`, so the storefront sees it.
6. **Poll the ImportOperations.** A 2xx from the Import API is an acknowledgement, not a result.
7. **Report** every row, record the run, release the lock.

`DRY_RUN=true` stops after step 4 and reports what *would* be imported, including unknown SKUs.

**Response to the scheduler:** `200` when the run completed (body `status: ok | failed | skipped`; failed
rows are already logged at ERROR); `500` when it couldn't complete at all (feed host down, credentials
rejected).

## Scopes

`inheritAs.apiClient.scopes`: Connect generates the client and injects the credentials. Nothing is
pasted at install.

| Scope | For |
|---|---|
| `view_products` | resolving SKU → product/variant keys |
| `manage_products` | the price import writes products |
| `manage_import_containers` | submitting and polling import operations |
| `manage_key_value_documents` | the run lock and the last-run record |

## Run locally

```bash
cd price-feed-job
cp .env.example .env            # CTP_* from an API client with the scopes above; FEED_URL=../samples/prices.csv
npm install && npm run build
DRY_RUN=true npm run once       # the job once from the CLI (no server); exits non-zero on failed rows
npm run dev                     # the HTTP app on :8080, then:
curl -X POST localhost:8080/price-feed
npm test                        # 25 tests: CSV parsing, money conversion, batching, polling, lock, skip-unchanged
```

**Prerequisites (seeded by the B2C-dev Session 7 seeder):** the `lhc-price-feed` ImportContainer
(`resourceType: price`), and price keys + variant keys on the demo products.

## Runbook

### The job did not run
Check the deployment's logs for the scheduler's call (`Feed read …`). `Skipped: another run is in
progress` means a lock held by a previous run; `Taking over a stale lock` means a crashed run's lock
expired after `LOCK_STALE_MINUTES`. `Skipped: the feed is unchanged` is normal on nights the file
didn't change.

### Some rows failed
Each one is logged at ERROR: `Feed row rejected` (the file is wrong; the line number is in the entry) or
`Row failed` (the Import API refused it, e.g. an unknown SKU or a missing key). Fix the file; the next run
retries, because a run with failures is never treated as "unchanged".

### A price imported but the storefront doesn't show it
The price key must match the one on the catalogue price (`SKU-CURRENCY[-COUNTRY]`); a new key adds a
price the storefront never selects. Imports write `staged: false`, so the current projection is updated;
search-backed listings are eventually consistent, so allow a moment.

## Platform limits worth knowing

| Limit | Effect on this code |
|---|---|
| Job request timeout **30 min** | The whole run happens inside the scheduler's request |
| **No concurrency guard** | The Custom Object lock |
| Import API: **20 resources** per request | Batches of 20 |
| Import API: a 2xx is an **acknowledgement** | ImportOperations are polled for the result |
| Sandbox deployments **scale to zero** | The first call after idle includes a ~15 s cold start; irrelevant to a nightly job |

## Verified (2026-10-02, project `ecoliving-home-furniture-dev`)

Live **dry runs** only (nothing submitted): the sample file resolves 6/6 rows, from a file path and over
HTTP, through both the CLI and `POST /price-feed` → 200. A file with an unknown SKU and a bad currency
reports both (line numbers included) and returns `failed`; a 404 feed fails the run. A real import (one
edited price, then checked in both storefronts) is the next step.
