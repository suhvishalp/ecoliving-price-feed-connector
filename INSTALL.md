# Install `ecoliving-price-feed-connector` — participant guide *(breakout room)*

One **Job** application, `price-feed-job`: on a cron schedule Connect calls it, it reads a **CSV of prices**, and
imports them through the **Import API** (by price key, so each row updates the price the storefront shows).

**What you need:** Merchant Center access to the course organization with permission to manage connectors, and the
course project key. Nothing to build locally: Connect builds the tag itself.

**The repository must be readable by Connect.** It is private outside the training; the trainer makes it public for the
day (or grants the `connect-mu` machine user read access). A "repository not found" in step 2 means it is still private.

## 1 · Create the connector *(everyone, in your own name)*

A connector starts as a **ConnectorStaged**: a pointer to a GitHub repository **at a tag**. Creating one never touches
the project, so every participant can do this step.

Merchant Center → **Connect** → **Manage connectors** → **Create connector**, then:

| Field | Value |
|---|---|
| Name | `EcoLiving Price Feed Connector — <your name>` |
| Key | `<yourname>-ecoliving-price-feed-connector` *(keys are unique in the organization: use your own name)* |
| Repository URL | `https://github.com/commercetools/ecoliving-price-feed-connector.git` |
| Tag | `v1.0.3` |
| Private projects | the course project, e.g. `europe-west1.gcp:<project-key>` |
| Supported regions | `europe-west1.gcp` |

<details><summary>The same step through the Connect API</summary>

```http
POST https://connect.europe-west1.gcp.commercetools.com/connectors/drafts
Authorization: Bearer <token with manage_connectors>
Content-Type: application/json

{
  "key": "<yourname>-ecoliving-price-feed-connector",
  "name": "EcoLiving Price Feed Connector — <your name>",
  "description": "The nightly CSV to Import API price feed as a Connect Job app.",
  "creator": { "title": "Participant", "name": "<your name>", "email": "<your email>", "company": "<company>", "noOfDevelopers": 1 },
  "repository": { "url": "https://github.com/commercetools/ecoliving-price-feed-connector.git", "tag": "v1.0.3" },
  "privateProjects": ["europe-west1.gcp:<project-key>"],
  "supportedRegions": ["europe-west1.gcp"]
}
```
</details>

## 2 · Request the preview and wait for the validation

Open your connector → **Request preview** (API: `updatePreviewable`). Connect clones the tag and runs its pipeline:
build, tests, dependency and code scan for every application. This takes **a few minutes**. Refresh until the
status is **previewable**. If it fails, the report names the application and the step; the connector in this repository
passes it, so a failure here is almost always a wrong URL or tag, or a repository Connect cannot read.

## 3 · Publish it for private use

**Publish** → certification **off** (API: `{ "action": "publish", "certification": false }`). Publishing makes it a
**Connector** your project can install. Certification is only for the public marketplace.

## 4 · Deploy it *(one person per room — read this first)*

> **One deployment of this connector per project.** Its `postDeploy` registers nothing on the platform (a Job registers no Extension or Subscription), but it **locks and records its runs** in the Custom Object container `lhc-price-feed` under a **fixed key**, so a
> second deployment on the same project overwrites the first one's registration, and undeploying either removes it for
> both. In the breakout room, **everyone does steps 1–3; one person (the driver) deploys**, with the others watching the
> screen. If each of you has your own project, everyone can deploy.

Merchant Center → **Connect** → **Manage connectors** → **Organization connectors** → your connector → **Install** →
choose the project, region `europe-west1.gcp`, deployment type **Sandbox**, then enter the values below.

You are **not** asked for API credentials: `connect.yaml` declares `inheritAs.apiClient.scopes`, and Connect generates an
API client with exactly those scopes (`view_products`, `manage_products`, `manage_import_containers`, `manage_key_value_documents`). That is least privilege you can read in the repository.

### Values

| Key | Sample value | Note |
|---|---|---|
| `FEED_URL` **(required, pre-filled)** | `https://raw.githubusercontent.com/commercetools/ecoliving-price-feed-connector/main/samples/prices.csv` | the course feed, read on every run; GitHub caches raw files for ~5 min |
| `FEED_SOURCE` | `csv` | |
| `IMPORT_CONTAINER_KEY` | `lhc-price-feed` | the seeder (Session 7) creates it |
| `FEED_CONTAINER` | `lhc-price-feed` | lock + last-run record |
| `FEED_KEY` | `pending` | only for `FEED_SOURCE=custom-object` |
| `SKIP_UNCHANGED_FEED` | `true` | an identical file stands down |
| `DRY_RUN` | `true` for your first run, then `false` | `true` reports what *would* be imported |
| `FEED_TIMEOUT_SECONDS` / `MAX_FEED_BYTES` | `30` / `5242880` | |
| `LOCK_STALE_MINUTES` | `45` | |
| `POLL_TIMEOUT_SECONDS` / `POLL_INTERVAL_SECONDS` | `120` / `5` | |
| `CTP_IMPORT_URL` | *(empty)* | derived from the API URL |
| `LOG_LEVEL` | `info` | |
| `FEED_AUTH_HEADER` *(secured)* | *(empty)* | only for a protected file host |

**Schedule:** every 15 minutes (`*/15 * * * *`), the course default, so a CSV edit shows up during the session. In
production it would run nightly (`0 2 * * *`); a deployment can override it with the `schedule` of its application
configuration. **Undeploy after the course**: it keeps calling GitHub and the Import API every 15 minutes.

## 5 · Verify it works

When the deployment is **Deployed**:

1. Wait for the next 15-minute tick (:00, :15, :30, :45), then open the app's log: lock taken → feed read (rows, sha256) → SKUs resolved →
   batches submitted → ImportOperations settled → run recorded → lock released.
2. With `DRY_RUN=true` the log lists the planned prices and stops. Redeploy with `DRY_RUN=false`.
3. Change a price: edit `samples/prices.csv` (e.g. `CARM-023,EUR,DE,449.00`) in a fork or ask the trainer to commit it,
   commit it a few minutes before a tick (GitHub caches raw files for ~5 minutes), and reload the storefront PLP in the DE/EUR store.
4. Unchanged file? The log says **skipped**: the job compared the file's hash with the last good run.

## 6 · Tear down

Undeploy at the end of the course. The lock and last-run record stay in `lhc-price-feed`; delete them if you want a clean slate.

## If something fails

| Symptom | Cause | Fix |
|---|---|---|
| Preview stays not previewable, "repository not found" | private repo, or a typo in the URL | check the URL; ask the trainer to open the repo |
| "Connector script postDeploy failed to execute" | open **Expand** in the script log: the last line names it | most often a missing secured value, or messages not enabled |
| Deployed, but nothing happens | the sandbox is asleep, or another deployment owns the fixed key | wake `/status`; check there is only one deployment of this connector |
