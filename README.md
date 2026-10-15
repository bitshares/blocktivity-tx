# blocktivity-tx

A [Blocktivity](https://blocktivity.info/add-your-chain) daily-transaction
endpoint for the **BitShares** blockchain.

A scheduled GitHub Actions job queries the public BitShares
Kibana/Elasticsearch cluster (`https://kibana.bitshares.dev`, index
`bitshares-*`) for the last 24 hours of signed transactions and publishes the
result as a static JSON file via GitHub Pages.

## Endpoint

Once GitHub Pages is enabled (Settings → Pages → Deploy from a branch →
`main` / `/docs`):

```
https://<owner>.github.io/blocktivity-tx/tx-daily.json
```

This URL is what goes into Blocktivity's `txEndpoint` field.

## Payload

```json
{
  "transactions": 32237,
  "period_start": "2026-10-14T22:30:00Z",
  "period_end":   "2026-10-15T22:30:00Z",
  "updated_at":   "2026-10-15T22:31:10Z",
  "chain": "BitShares",
  "chain_id": "mainnet",
  "period": "24h",
  "from_block": 115230156,
  "to_block": 115258879,
  "transaction_definition": "Successful user-submitted transactions; virtual/system operations (e.g. fill_order, asset_settle_cancel) excluded.",
  "failed_transactions_included": false,
  "system_transactions_included": false
}
```

### Count semantics

- The index stores **one document per (operation × impacted account)**, so
  counting documents overcounts and `cardinality` aggregations are only
  approximate. Distinct transactions are therefore enumerated exactly with a
  paginated `composite` aggregation over `block_data.trx_id.keyword`
  (~5 pages of 10k, ~2 s total), counting **signed transactions**, not
  operations (~32k vs ~113k per day).
- `operation_history.is_virtual: false` excludes chain-generated virtual
  operations (e.g. `fill_order`, `asset_settle_cancel`).

### Keeping the schedule alive

GitHub disables scheduled workflows in public repositories after **60 days
without commits**, not after 60 days without scheduled activity (see the
[GitHub docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)).
This workflow commits a refreshed `docs/tx-daily.json` every hour, so the
60-day clock is reset continuously and the schedule runs indefinitely.
If it ever stops, re-enable it once in the Actions tab.

## Blocktivity submission notes

| Field | Value |
|---|---|
| `name` | BitShares |
| `symbol` | BTS |
| `website` | https://bitshares.org |
| `txDefinition.window` | `rolling-24h` |
| `txDefinition.successful` | `included` |
| `txDefinition.failed` | `excluded` |
| `txDefinition.system` | `excluded` |
| `txDefinition.internal` | `excluded` |
| `txDefinition.batched` | `individually` |
| `txDefinition.rollup` | `n-a` |
| `idCg` | `bitshares` |
| `idCmc` | `463` |

The **submitter** (the named organisation that stands behind the data) and the
authenticity proof are separate from this endpoint and must be arranged by the
submitting organisation.

## Local run

```bash
npm run tx        # writes docs/tx-daily.json
```

Optional env overrides: `KIBANA_URL`, `KIBANA_INDEX`.
