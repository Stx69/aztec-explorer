/**
 * Polls the local Aztec node and writes L2 blocks and transactions into MongoDB.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { connectMongo } from "../../lib/mongo.mjs";

const DB = "aztec";
const BATCH = 10;
const POLL_MS = 2000;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const require = createRequire(path.join(repoRoot, "package.json"));
const { createAztecNodeClient } = require("@aztec/aztec.js/node");

const dbUrl = process.env.DB_URL ?? "mongodb://127.0.0.1:27017";
const nodeUrl = process.env.PXE_URL ?? "http://127.0.0.1:8080";

function field(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value.toString === "function") return value.toString();
  return String(value);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeBlock(block) {
  const effects = block.body?.txEffects ?? [];
  const txs = effects.map((effect, index) => ({
    hash: field(effect.txHash),
    blockNumber: num(block.number),
    timestamp: num(block.header.globalVariables.timestamp),
    index,
    fee: field(effect.transactionFee),
    revertCode: field(effect.revertCode),
    nullifierCount: effect.nullifiers?.length ?? 0,
    noteHashCount: effect.noteHashes?.length ?? 0,
    publicWrites: (effect.publicDataWrites ?? []).slice(0, 64).map((write) => ({
      leafSlot: field(write.leafSlot),
      value: field(write.value),
    })),
    publicLogs: (effect.publicLogs ?? []).slice(0, 32).map((log) => ({
      contractAddress: field(log.contractAddress),
      fields: (log.fields ?? []).slice(0, 8).map(field),
    })),
  }));

  return {
    block: {
      number: num(block.number),
      hash: field(block.hash),
      timestamp: num(block.header.globalVariables.timestamp),
      slot: num(block.header.globalVariables.slotNumber),
      chainId: field(block.header.globalVariables.chainId),
      checkpointNumber: num(block.checkpointNumber),
      indexWithinCheckpoint: num(block.indexWithinCheckpoint),
      txCount: txs.length,
      txHashes: txs.map((tx) => tx.hash),
      archiveRoot: field(block.archive?.root),
    },
    txs,
  };
}

async function ensureIndexes(mongo) {
  await mongo.command({
    createIndexes: "blocks",
    indexes: [{ key: { number: 1 }, name: "number_unique", unique: true }],
    $db: DB,
  });
  await mongo.command({
    createIndexes: "txs",
    indexes: [
      { key: { hash: 1 }, name: "hash_unique", unique: true },
      { key: { blockNumber: -1 }, name: "blockNumber" },
    ],
    $db: DB,
  });
}

async function findLatestNumber(mongo) {
  const result = await mongo.command({
    find: "blocks",
    filter: {},
    sort: { number: -1 },
    limit: 1,
    $db: DB,
  });
  const doc = result.cursor?.firstBatch?.[0];
  return doc ? num(doc.number) : 0;
}

async function readCursor(mongo) {
  const result = await mongo.command({
    find: "meta",
    filter: { _id: "cursor" },
    limit: 1,
    $db: DB,
  });
  const doc = result.cursor?.firstBatch?.[0];
  return doc ? num(doc.nextBlock) : 1;
}

async function writeCursor(mongo, nextBlock) {
  await mongo.command({
    update: "meta",
    updates: [
      {
        q: { _id: "cursor" },
        u: { _id: "cursor", nextBlock, updatedAt: Date.now() },
        upsert: true,
      },
    ],
    $db: DB,
  });
}

async function insertMany(mongo, collection, documents) {
  if (documents.length === 0) return;
  await mongo.command({
    insert: collection,
    documents,
    ordered: true,
    $db: DB,
  });
}

async function syncOnce(node, mongo) {
  const latest = num(await node.getBlockNumber());
  let cursor = await readCursor(mongo);
  if (cursor > latest) return cursor;

  while (cursor <= latest) {
    const limit = Math.min(BATCH, latest - cursor + 1);
    const blocks = await node.getBlocks(cursor, limit, { includeTransactions: true });
    if (!blocks?.length) break;

    for (const block of blocks) {
      const summary = summarizeBlock(block);
      await insertMany(mongo, "blocks", [summary.block]);
      await insertMany(mongo, "txs", summary.txs);
      cursor = summary.block.number + 1;
      await writeCursor(mongo, cursor);
      console.log(
        `[explorer-indexer] block ${summary.block.number} txs=${summary.block.txCount} hash=${summary.block.hash}`,
      );
    }
  }
  return cursor;
}

async function main() {
  console.log(`[explorer-indexer] node ${nodeUrl} db ${dbUrl}`);
  const mongo = connectMongo(dbUrl);
  await mongo.hello();
  await ensureIndexes(mongo);
  const node = createAztecNodeClient(nodeUrl);

  for (;;) {
    try {
      await syncOnce(node, mongo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("E11000")) {
        const latestStored = await findLatestNumber(mongo);
        const next = latestStored + 1;
        await writeCursor(mongo, next);
        console.error(`[explorer-indexer] duplicate key, cursor moved to ${next}`);
      } else {
        console.error(`[explorer-indexer] ${message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
