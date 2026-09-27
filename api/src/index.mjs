/**
 * Read API over the explorer Mongo database.
 * Blocks, transactions, and public state writes indexed from the Aztec node.
 */
import crypto from "node:crypto";
import http from "node:http";
import { connectMongo } from "../../lib/mongo.mjs";

const DB = "aztec";
const PORT = Number(process.env.PORT ?? 3000);
const dbUrl = process.env.DB_URL ?? "mongodb://127.0.0.1:27017";
const cors = process.env.ENABLE_CORS === "true";

function send(response, status, body) {
  const payload = JSON.stringify(body);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  };
  if (cors) {
    headers["access-control-allow-origin"] = "*";
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
  }
  response.writeHead(status, headers);
  response.end(payload);
}

async function find(mongo, collection, filter, { sort, limit = 20, skip = 0 } = {}) {
  const result = await mongo.command({
    find: collection,
    filter,
    sort,
    limit,
    skip,
    $db: DB,
  });
  return result.cursor?.firstBatch ?? [];
}

async function count(mongo, collection, filter = {}) {
  const result = await mongo.command({
    count: collection,
    query: filter,
    $db: DB,
  });
  return result.n ?? 0;
}

const ZERO_FR = `0x${"0".repeat(64)}`;
const ZERO_ETH = `0x${"0".repeat(40)}`;

function padFr(value) {
  const hex = String(value ?? "").replace(/^0x/i, "").padStart(64, "0").slice(-64);
  return `0x${hex}`;
}

function tree(root) {
  return { root: padFr(root), nextAvailableLeafIndex: 0 };
}

function toLightBlock(doc) {
  return {
    hash: padFr(doc.hash),
    height: doc.number,
    nativeStatus: "proposed",
    archive: tree(doc.archiveRoot),
    header: {
      lastArchive: tree(doc.archiveRoot),
      spongeBlobHash: ZERO_FR,
      state: {
        l1ToL2MessageTree: tree(null),
        partial: {
          noteHashTree: tree(null),
          nullifierTree: tree(null),
          publicDataTree: tree(null),
        },
      },
      globalVariables: {
        chainId: 0,
        version: 1,
        blockNumber: doc.number,
        slotNumber: doc.slot || doc.number,
        timestamp: String(doc.timestamp ?? 0),
        coinbase: ZERO_ETH,
        feeRecipient: ZERO_FR,
        gasFees: { feePerDaGas: "0", feePerL2Gas: "0" },
      },
      totalFees: "0",
      totalManaUsed: "0",
    },
    body: {
      txEffects: (doc.txHashes ?? []).map((txHash) => ({ txHash: padFr(txHash) })),
    },
  };
}

function toTableRow(doc) {
  return {
    blockHash: padFr(doc.hash),
    height: doc.number,
    timestamp: String(doc.timestamp ?? 0),
    txEffectsLength: doc.txCount ?? 0,
    nativeStatus: "proposed",
    orphan: false,
  };
}

async function latestStoredBlock(mongo) {
  const rows = await find(mongo, "blocks", {}, { sort: { number: -1 }, limit: 1 });
  return rows[0] ?? null;
}

async function handleChicmoz(mongo, url, path) {
  if (path === "/l2/latest-height") {
    const latest = await latestStoredBlock(mongo);
    return latest?.number ?? 0;
  }

  if (path === "/l2/blocks/latest") {
    const latest = await latestStoredBlock(mongo);
    if (!latest) return { status: 404, error: "no blocks" };
    return toLightBlock(latest);
  }

  const heightMatch = path.match(/^\/l2\/blocks\/(\d+)$/);
  if (heightMatch) {
    const rows = await find(mongo, "blocks", { number: Number(heightMatch[1]) }, { limit: 1 });
    if (!rows[0]) return { status: 404, error: "block not found" };
    return toLightBlock(rows[0]);
  }

  const hashMatch = path.match(/^\/l2\/blocks\/(0x[0-9a-fA-F]+)$/);
  if (hashMatch) {
    const rows = await find(mongo, "blocks", { hash: hashMatch[1] }, { limit: 1 });
    if (!rows[0]) return { status: 404, error: "block not found" };
    return toLightBlock(rows[0]);
  }

  if (path === "/l2/ui/blocks-for-table") {
    const status = url.searchParams.get("status");
    if (status && status !== "proposed" && status !== "unknown") {
      return [];
    }
    const from = Number(url.searchParams.get("from") ?? 1);
    const to = url.searchParams.get("to");
    const filter = { number: { $gte: from } };
    if (to != null && to !== "") filter.number.$lt = Number(to);
    const rows = await find(mongo, "blocks", filter, { sort: { number: -1 }, limit: 100 });
    return rows.map(toTableRow);
  }

  if (path === "/l2/blocks/by-status" || path === "/l2/blocks/orphans" || path === "/l2/reorgs") {
    return [];
  }

  if (path === "/l2/tips") {
    const latest = await latestStoredBlock(mongo);
    const height = latest?.number ?? 0;
    const hash = padFr(latest?.hash);
    const block = { number: height, hash };
    const checkpoint = {
      block,
      checkpoint: { number: latest?.checkpointNumber ?? 0, hash },
    };
    return {
      tips: {
        proposed: block,
        checkpointed: checkpoint,
        proven: checkpoint,
        finalized: checkpoint,
      },
      observedAt: Date.now(),
      stale: false,
      stalenessMs: 0,
      staleAfterMs: 120000,
      degraded: false,
      source: { rpcNodeName: "local", aztecNodeVersion: "local" },
    };
  }

  if (path === "/l2/info") {
    const zero = ZERO_ETH;
    return {
      l2NetworkId: "SANDBOX",
      l1ChainId: 31337,
      rollupVersion: "0",
      l1ContractAddresses: {
        rollupAddress: zero,
        registryAddress: zero,
        inboxAddress: zero,
        outboxAddress: zero,
        feeJuiceAddress: zero,
        feeJuicePortalAddress: zero,
        coinIssuerAddress: zero,
        rewardDistributorAddress: zero,
        governanceProposerAddress: zero,
        governanceAddress: zero,
        stakingAssetAddress: zero,
      },
      protocolContractAddresses: {
        classRegistry: ZERO_FR,
        feeJuice: ZERO_FR,
        instanceRegistry: ZERO_FR,
        multiCallEntrypoint: ZERO_FR,
      },
      feeJuiceSymbol: "AZTEC",
      feeJuiceDecimals: 0,
    };
  }

  if (path === "/l2/rpc-nodes") {
    const now = new Date().toISOString();
    return [
      {
        rpcNodeName: "local",
        l2NetworkId: "SANDBOX",
        rollupVersion: "0",
        nodeVersion: "local",
        l1ChainId: 31337,
        createdAt: now,
        lastSeenAt: now,
      },
    ];
  }

  if (
    path === "/l2/errors" ||
    path === "/l2/rollup-versions" ||
    path === "/l2/fee-recipients" ||
    path === "/l2/txs" ||
    path === "/l2/contract-classes" ||
    path === "/l2/contract-instances" ||
    path === "/l2/contract-instances/with-aztec-scan-notes" ||
    path === "/l1/l2-validators" ||
    path === "/l1/contract-events" ||
    path === "/l1/governance/proposals" ||
    path === "/l1/governance/signals" ||
    path === "/l1/governance/configurations" ||
    path === "/l1/governance/proposer-history"
  ) {
    return [];
  }

  if (path === "/l1/l2-validators/totals") {
    return { total: 0, validating: 0, nonValidating: 0, statusCounts: {} };
  }

  if (path === "/l1/contract-events/hourly-counts") {
    return [];
  }

  if (path === "/l2/stats/total-tx-effects") {
    return String(await count(mongo, "txs"));
  }
  if (path === "/l2/stats/tx-effects-last-24h") {
    const since = Math.floor(Date.now() / 1000) - 86400;
    return String(await count(mongo, "txs", { timestamp: { $gte: since } }));
  }
  if (path === "/l2/stats/dropped-txs-last-24h" || path === "/l2/stats/total-contracts" || path === "/l2/stats/total-contract-instances" || path === "/l2/stats/total-contracts-last-24h" || path === "/l2/stats/average-fees") {
    return "0";
  }
  if (path === "/l2/stats/contract-classes-summary") {
    return { totalClasses: 0, verifiedClasses: 0, protocolClasses: 0 };
  }
  if (path === "/l2/stats/average-txs-per-block") {
    const blocks = await count(mongo, "blocks");
    const txs = await count(mongo, "txs");
    return blocks > 0 ? String(txs / blocks) : "0";
  }
  if (path === "/l2/stats/average-block-time") {
    return "12000";
  }

  const tableByHeight = path.match(/^\/l2\/ui\/tx-effects-for-table\/(\d+)$/);
  if (tableByHeight) {
    const txs = await find(
      mongo,
      "txs",
      { blockNumber: Number(tableByHeight[1]) },
      { sort: { index: 1 }, limit: 200 },
    );
    return txs.map((tx) => ({
      blockNumber: tx.blockNumber,
      txHash: padFr(tx.hash),
      transactionFee: displayFee(tx.fee),
      timestamp: String(tx.timestamp ?? 0),
    }));
  }

  if (path === "/l2/tx-effects" || path === "/l2/ui/tx-effects-for-table") {
    const txs = await find(mongo, "txs", {}, { sort: { blockNumber: -1 }, limit: 50 });
    if (path.endsWith("tx-effects-for-table")) {
      return txs.map((tx) => ({
        blockNumber: tx.blockNumber,
        txHash: padFr(tx.hash),
        transactionFee: displayFee(tx.fee),
        timestamp: String(tx.timestamp ?? 0),
      }));
    }
    return txs.map((tx) => toDeluxeTx(tx));
  }

  const blockTxMatch = path.match(/^\/l2\/blocks\/(\d+)\/tx-effects$/);
  if (blockTxMatch) {
    const txs = await find(mongo, "txs", { blockNumber: Number(blockTxMatch[1]) }, { sort: { index: 1 }, limit: 200 });
    return txs.map((tx) => toDeluxeTx(tx));
  }

  const txHashMatch = path.match(/^\/l2\/tx-effects\/(0x[0-9a-fA-F]+)$/);
  if (txHashMatch) {
    const tx = await findTxByHash(mongo, txHashMatch[1]);
    if (!tx) return { status: 404, error: "transaction not found" };
    return toDeluxeTx(tx);
  }

  if (path.startsWith("/l2/public-call-requests")) {
    return [];
  }

  const pendingMatch = path.match(/^\/l2\/txs\/(0x[0-9a-fA-F]+)$/);
  if (pendingMatch) {
    return { absent: true };
  }

  const droppedMatch = path.match(/^\/l2\/dropped-txs\/(0x[0-9a-fA-F]+)$/);
  if (droppedMatch) {
    return { absent: true };
  }

  const instanceMatch = path.match(/^\/l2\/contract-instances\/(0x[0-9a-fA-F]+)$/);
  if (instanceMatch) {
    return contractInstance(padFr(instanceMatch[1]), ZERO_FR);
  }

  if (path === "/l2/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const body = emptySearch(q);
    if (/^\d+$/.test(q)) {
      const rows = await find(mongo, "blocks", { number: Number(q) }, { limit: 1 });
      if (rows[0]) {
        body.results.blocks.push({
          hash: padFr(rows[0].hash),
          blockNumber: rows[0].number,
          slotNumber: rows[0].slot || rows[0].number,
        });
      }
      return body;
    }
    if (/^0x[0-9a-fA-F]+$/.test(q)) {
      const tx = await findTxByHash(mongo, q);
      if (tx) body.results.txEffects.push({ txHash: padFr(tx.hash) });
      const blocks = await find(mongo, "blocks", { hash: padFr(q) }, { limit: 1 });
      if (blocks[0]) {
        body.results.blocks.push({
          hash: padFr(blocks[0].hash),
          blockNumber: blocks[0].number,
          slotNumber: blocks[0].slot || blocks[0].number,
        });
      }
      const address = padFr(q);
      const mentioned = await find(
        mongo,
        "txs",
        { "publicLogs.contractAddress": address },
        { limit: 1 },
      );
      if (mentioned[0] || (!tx && !blocks[0])) {
        body.results.contractInstances.push({ address });
      }
    }
    return body;
  }

  return null;
}

function displayFee(fee) {
  const text = String(fee ?? "0");
  if (text.startsWith("0x") || text.length > 18) return "0";
  return text;
}

const ZERO_POINT = `0x${"0".repeat(128)}`;

function emptySearch(q) {
  return {
    searchPhrase: q,
    results: {
      blocks: [],
      txEffects: [],
      droppedTx: [],
      pendingTx: [],
      registeredContractClasses: [],
      contractInstances: [],
      validators: [],
      accounts: [],
    },
  };
}

async function findTxByHash(mongo, hash) {
  const candidates = [...new Set([hash, padFr(hash), hash.toLowerCase()])];
  for (const candidate of candidates) {
    const rows = await find(mongo, "txs", { hash: candidate }, { limit: 1 });
    if (rows[0]) return rows[0];
  }
  return null;
}

function contractInstance(address, blockHash) {
  return {
    address: padFr(address),
    blockHash: padFr(blockHash),
    version: 1,
    salt: ZERO_FR,
    currentContractClassId: ZERO_FR,
    originalContractClassId: ZERO_FR,
    initializationHash: ZERO_FR,
    immutablesHash: ZERO_FR,
    deployer: ZERO_FR,
    publicKeys: {
      masterNullifierPublicKey: ZERO_POINT,
      masterIncomingViewingPublicKey: ZERO_POINT,
      masterOutgoingViewingPublicKey: ZERO_POINT,
      masterTaggingPublicKey: ZERO_POINT,
    },
    contractClassId: ZERO_FR,
    artifactHash: ZERO_FR,
    privateFunctionsRoot: ZERO_FR,
    packedBytecode: { type: "Buffer", data: [0] },
    isOrphaned: false,
  };
}

function toDeluxeTx(tx) {
  return {
    revertCode: { code: 0 },
    txHash: padFr(tx.hash),
    transactionFee: displayFee(tx.fee),
    noteHashes: [],
    nullifiers: [],
    l2ToL1Msgs: [],
    publicDataWrites: (tx.publicWrites ?? []).map((write) => ({
      leafSlot: padFr(write.leafSlot),
      value: padFr(write.value),
    })),
    privateLogs: [],
    publicLogs: (tx.publicLogs ?? []).map((log) => ({
      contractAddress: padFr(log.contractAddress),
      fields: (log.fields ?? []).map((field) => padFr(field)),
    })),
    contractClassLogs: [],
    blockHeight: tx.blockNumber,
    blockHash: ZERO_FR,
    isOrphaned: false,
    txBirthTimestamp: (tx.timestamp ?? 0) * 1000,
    timestamp: String(tx.timestamp ?? 0),
  };
}

async function handle(mongo, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  const chicmoz = path.match(/^\/v1\/[^/]+(\/.*)$/);
  if (chicmoz) {
    const result = await handleChicmoz(mongo, url, chicmoz[1]);
    if (result !== null) return result;
  }

  if (path === "/health" || path === "/api/v1/status") {
    const cursor = await find(mongo, "meta", { _id: "cursor" }, { limit: 1 });
    const blocks = await count(mongo, "blocks");
    const txs = await count(mongo, "txs");
    const latest = await find(mongo, "blocks", {}, { sort: { number: -1 }, limit: 1 });
    return {
      ok: true,
      blocks,
      txs,
      nextBlock: cursor[0]?.nextBlock ?? 1,
      latest: latest[0] ?? null,
    };
  }

  if (path === "/api/v1/blocks") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
    const skip = Math.max(Number(url.searchParams.get("skip") ?? 0), 0);
    const blocks = await find(mongo, "blocks", {}, { sort: { number: -1 }, limit, skip });
    return { blocks, limit, skip };
  }

  const blockMatch = path.match(/^\/api\/v1\/blocks\/(\d+)$/);
  if (blockMatch) {
    const number = Number(blockMatch[1]);
    const blocks = await find(mongo, "blocks", { number }, { limit: 1 });
    if (!blocks[0]) return { status: 404, error: "block not found" };
    const txs = await find(mongo, "txs", { blockNumber: number }, { sort: { index: 1 }, limit: 200 });
    return { block: blocks[0], txs };
  }

  const txMatch = path.match(/^\/api\/v1\/txs\/(0x[0-9a-fA-F]+)$/);
  if (txMatch) {
    const txs = await find(mongo, "txs", { hash: txMatch[1] }, { limit: 1 });
    if (!txs[0]) return { status: 404, error: "transaction not found" };
    return { tx: txs[0] };
  }

  if (path === "/api/v1/search") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (/^\d+$/.test(query)) {
      const blocks = await find(mongo, "blocks", { number: Number(query) }, { limit: 1 });
      return { kind: "block", block: blocks[0] ?? null };
    }
    if (/^0x[0-9a-fA-F]+$/.test(query)) {
      const txs = await find(mongo, "txs", { hash: query }, { limit: 1 });
      if (txs[0]) return { kind: "tx", tx: txs[0] };
      const blocks = await find(mongo, "blocks", { hash: query }, { limit: 1 });
      return { kind: "block", block: blocks[0] ?? null };
    }
    return { status: 400, error: "query must be a block number or 0x hash" };
  }

  return { status: 404, error: "not found" };
}

async function main() {
  const mongo = connectMongo(dbUrl);
  await mongo.hello();
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      send(response, 204, {});
      return;
    }
    if (request.method !== "GET") {
      send(response, 405, { error: "method not allowed" });
      return;
    }
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
      const result = await handle(mongo, url);
      const status = result != null && !Array.isArray(result) && result.status ? result.status : 200;
      send(response, status, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(response, 500, { error: message });
    }
  });
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("data", (buf) => {
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) socket.end();
      if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]));
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    sendWsText(socket, JSON.stringify({ topic: "block" }));
  });

  let lastHeight = -1;
  setInterval(async () => {
    try {
      const latest = await latestStoredBlock(mongo);
      const height = latest?.number ?? 0;
      if (height === lastHeight) return;
      lastHeight = height;
      const payload = JSON.stringify({ topic: "block", block: height });
      for (const socket of sockets) sendWsText(socket, payload);
    } catch {
      // The next tick retries after a brief Mongo miss.
    }
  }, 2000);

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[explorer-api] http://127.0.0.1:${PORT} ws://127.0.0.1:${PORT} db ${dbUrl}`);
  });
}

function sendWsText(socket, text) {
  const payload = Buffer.from(text);
  const header = [0x81];
  if (payload.length < 126) {
    header.push(payload.length);
  } else {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  }
  socket.write(Buffer.concat([Buffer.from(header), payload]));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
