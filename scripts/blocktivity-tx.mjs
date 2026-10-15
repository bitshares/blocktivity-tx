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
 * Count semantics: signed (non-virtual) transactions in the last 24 hours.
 * `block_data.trx_id.keyword` is one document per operation, so a cardinality
 * aggregation over it yields distinct signed transactions; virtual operations
 * (fill_order, asset_settle_cancel, ...) are filtered out.
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

const TRANSACTION_DEFINITION =
  'Successful user-submitted transactions; virtual/system operations ' +
  '(e.g. fill_order, asset_settle_cancel) excluded.';

// ─── Kibana query ────────────────────────────────────────────────────────────

function buildQuery(from, to) {
  return {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { range: { 'block_data.block_time': { gte: from, lte: to, format: 'strict_date_optional_time' } } },
          { term: { 'operation_history.is_virtual': false } },
        ],
      },
    },
    aggs: {
      transactions: { cardinality: { field: 'block_data.trx_id.keyword', precision_threshold: 40000 } },
      operations: { value_count: { field: 'operation_id_num' } },
      from_block: { min: { field: 'block_data.block_num' } },
      to_block: { max: { field: 'block_data.block_num' } },
    },
  };
}

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

// ─── Payload ─────────────────────────────────────────────────────────────────

function buildPayload(now, es) {
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const agg = es.aggregations || {};
  const transactions = Math.round(Number(agg.transactions?.value ?? 0));

  const payload = {
    transactions,
    period_start: from.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    period_end: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    updated_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    chain: 'BitShares',
    chain_id: 'mainnet',
    period: '24h',
    transaction_definition: TRANSACTION_DEFINITION,
    failed_transactions_included: false,
    system_transactions_included: false,
  };

  const fromBlock = Number(agg.from_block?.value);
  const toBlock = Number(agg.to_block?.value);
  if (Number.isFinite(fromBlock)) payload.from_block = fromBlock;
  if (Number.isFinite(toBlock)) payload.to_block = toBlock;

  return payload;
}

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
  const query = buildQuery(
    new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    now.toISOString(),
  );

  const es = await kibanaSearch(query);
  const payload = buildPayload(now, es);

  const errors = validate(payload);
  if (errors.length) {
    throw new Error(`Refusing to write invalid payload:\n  - ${errors.join('\n  - ')}`);
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(
    `Wrote ${OUT_PATH}\n` +
      `  transactions : ${payload.transactions}\n` +
      `  blocks       : ${payload.from_block} → ${payload.to_block}\n` +
      `  updated_at   : ${payload.updated_at}`,
  );
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
