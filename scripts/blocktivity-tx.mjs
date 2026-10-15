#!/usr/bin/env node
/**
 * blocktivity-tx.mjs
 *
 * Builds Blocktivity's daily-transaction endpoint payload for BitShares from
 * the public BitShares Kibana/Elasticsearch cluster, and writes it to
 * docs/tx-daily.json (served by GitHub Pages).
 *
 * Blocktivity shape (https://blocktivity.info/listing-spec):
 *   {
 *     "transactions":   integer,
 *     "period_start":   ISO 8601 UTC,
 *     "period_end":     ISO 8601 UTC,
 *     "updated_at":     ISO 8601 UTC (must be < 24h old at fetch time),
 *     ...optional fields...
 *   }
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*  (time field: block_data.block_time)
 *
 * Count semantics: distinct signed (non-virtual) transactions in the last
 * 24 hours. The Elasticsearch index stores one document per (operation x
 * impacted account), so counting documents overcounts and a `cardinality`
 * aggregation is only approximate. Distinct transactions are therefore
 * enumerated exactly with a paginated `composite` aggregation over
 * `block_data.trx_id.keyword`, filtered to `operation_history.is_virtual:false`
 * (chain-generated virtual operations such as fill_order are excluded).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(REPO_ROOT, 'docs', 'tx-daily.json');

const KIBANA_URL = process.env.KIBANA_URL || 'https://kibana.bitshares.dev';
const INDEX = process.env.KIBANA_INDEX || 'bitshares-*';
const REQUEST_TIMEOUT_MS = 30_000;
const RETRIES = 3;

// composite page size is bounded by the cluster's search.max_buckets (10k).
const COMPOSITE_PAGE = 10_000;
const MAX_PAGES = 200; // hard stop against a runaway pagination loop

const TRANSACTION_DEFINITION =
  'Successful user-submitted transactions; virtual/system operations ' +
  '(e.g. fill_order, asset_settle_cancel) excluded.';

// ─── Kibana query helpers ────────────────────────────────────────────────────

const windowFilter = (from, to) => ({
  bool: {
    filter: [
      { range: { 'block_data.block_time': { gte: from, lte: to, format: 'strict_date_optional_time' } } },
      { term: { 'operation_history.is_virtual': false } },
    ],
  },
});

async function kibanaSearch(query) {
  const url =
    `${KIBANA_URL}/api/console/proxy?path=${encodeURIComponent(INDEX + '/_search')}&method=POST`;

  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'kbn-xsrf': 'true' },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Kibana HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`Kibana query failed after ${RETRIES} attempts: ${lastError?.message || lastError}`);
}

/** Block-number bounds of the window (informational, for audibility). */
async function fetchBlockRange(from, to) {
  const res = await kibanaSearch({
    size: 0,
    track_total_hits: false,
    query: windowFilter(from, to),
    aggs: {
      from_block: { min: { field: 'block_data.block_num' } },
      to_block: { max: { field: 'block_data.block_num' } },
    },
  });
  const agg = res.aggregations || {};
  const fromBlock = Number(agg.from_block?.value);
  const toBlock = Number(agg.to_block?.value);
  return {
    from_block: Number.isFinite(fromBlock) ? fromBlock : undefined,
    to_block: Number.isFinite(toBlock) ? toBlock : undefined,
  };
}

/** Exact number of distinct non-virtual transactions in the window. */
async function countDistinctTransactions(from, to) {
  let after = null;
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const composite = {
      size: COMPOSITE_PAGE,
      sources: [{ trx: { terms: { field: 'block_data.trx_id.keyword' } } }],
    };
    if (after) composite.after = after;

    const res = await kibanaSearch({
      size: 0,
      track_total_hits: false,
      query: windowFilter(from, to),
      aggs: { transactions: { composite } },
    });

    const agg = res.aggregations?.transactions;
    const buckets = agg?.buckets ?? [];
    total += buckets.length;
    after = agg?.after_key;

    if (!after || buckets.length === 0) return total;
  }

  throw new Error(`composite pagination exceeded ${MAX_PAGES} pages`);
}

// ─── Payload ─────────────────────────────────────────────────────────────────

function buildPayload(now, transactions, range) {
  return {
    transactions,
    period_start: iso(now.getTime() - 24 * 60 * 60 * 1000),
    period_end: iso(now.getTime()),
    updated_at: iso(now.getTime()),
    chain: 'BitShares',
    chain_id: 'mainnet',
    period: '24h',
    ...(range.from_block !== undefined ? { from_block: range.from_block } : {}),
    ...(range.to_block !== undefined ? { to_block: range.to_block } : {}),
    transaction_definition: TRANSACTION_DEFINITION,
    failed_transactions_included: false,
    system_transactions_included: false,
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function validate(payload) {
  const errors = [];
  if (!Number.isInteger(payload.transactions) || payload.transactions < 0) {
    errors.push('transactions must be an integer >= 0');
  }
  for (const f of ['period_start', 'period_end', 'updated_at']) {
    if (typeof payload[f] !== 'string' || Number.isNaN(Date.parse(payload[f]))) {
      errors.push(`${f} must be a valid ISO 8601 timestamp`);
    }
  }
  return errors;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const from = iso(now.getTime() - 24 * 60 * 60 * 1000);
  const to = iso(now.getTime());

  const [transactions, range] = await Promise.all([
    countDistinctTransactions(from, to),
    fetchBlockRange(from, to),
  ]);

  const payload = buildPayload(now, transactions, range);

  const errors = validate(payload);
  if (errors.length) {
    throw new Error(`Refusing to write invalid payload:\n  - ${errors.join('\n  - ')}`);
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(
    `Wrote ${OUT_PATH}\n` +
      `  transactions : ${payload.transactions} (exact distinct trx)\n` +
      `  blocks       : ${payload.from_block} → ${payload.to_block}\n` +
      `  updated_at   : ${payload.updated_at}`,
  );
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
