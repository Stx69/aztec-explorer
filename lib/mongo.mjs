/**
 * Minimal MongoDB OP_MSG client for the local explorer.
 * Speaks the wire protocol so the indexer and API need no extra npm packages.
 */
import net from "node:net";

const OP_MSG = 2013;

function encodeCString(value) {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function encodeString(value) {
  const bytes = Buffer.from(String(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeInt32LE(bytes.length + 1);
  return Buffer.concat([header, bytes, Buffer.from([0])]);
}

function encodeValue(value) {
  if (value === null) return { type: 0x0a, payload: Buffer.alloc(0) };
  if (typeof value === "boolean") {
    return { type: 0x08, payload: Buffer.from([value ? 1 : 0]) };
  }
  if (typeof value === "bigint") {
    const payload = Buffer.alloc(8);
    payload.writeBigInt64LE(value);
    return { type: 0x12, payload };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      const payload = Buffer.alloc(4);
      payload.writeInt32LE(value);
      return { type: 0x10, payload };
    }
    const payload = Buffer.alloc(8);
    payload.writeDoubleLE(value);
    return { type: 0x01, payload };
  }
  if (typeof value === "string") {
    return { type: 0x02, payload: encodeString(value) };
  }
  if (Array.isArray(value)) {
    const doc = {};
    value.forEach((item, index) => {
      doc[String(index)] = item;
    });
    return { type: 0x04, payload: encodeDocument(doc) };
  }
  if (typeof value === "object") {
    return { type: 0x03, payload: encodeDocument(value) };
  }
  throw new Error(`Unsupported BSON value: ${typeof value}`);
}

function encodeDocument(object) {
  const parts = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    const encoded = encodeValue(value);
    parts.push(Buffer.from([encoded.type]), encodeCString(key), encoded.payload);
  }
  const body = Buffer.concat(parts);
  const length = Buffer.alloc(4);
  length.writeInt32LE(body.length + 5);
  return Buffer.concat([length, body, Buffer.from([0])]);
}

function decodeDocument(buffer, offset = 0) {
  const length = buffer.readInt32LE(offset);
  const end = offset + length - 1;
  let index = offset + 4;
  const object = {};
  while (index < end) {
    const type = buffer[index++];
    const keyEnd = buffer.indexOf(0, index);
    const key = buffer.toString("utf8", index, keyEnd);
    index = keyEnd + 1;
    if (type === 0x01) {
      object[key] = buffer.readDoubleLE(index);
      index += 8;
    } else if (type === 0x02) {
      const size = buffer.readInt32LE(index);
      index += 4;
      object[key] = buffer.toString("utf8", index, index + size - 1);
      index += size;
    } else if (type === 0x03) {
      const size = buffer.readInt32LE(index);
      object[key] = decodeDocument(buffer, index);
      index += size;
    } else if (type === 0x04) {
      const size = buffer.readInt32LE(index);
      object[key] = Object.values(decodeDocument(buffer, index));
      index += size;
    } else if (type === 0x05) {
      const size = buffer.readInt32LE(index);
      index += 4 + 1 + size;
      object[key] = null;
    } else if (type === 0x07) {
      object[key] = buffer.subarray(index, index + 12).toString("hex");
      index += 12;
    } else if (type === 0x08) {
      object[key] = buffer[index] === 1;
      index += 1;
    } else if (type === 0x09 || type === 0x11 || type === 0x12) {
      object[key] = Number(buffer.readBigInt64LE(index));
      index += 8;
    } else if (type === 0x0a) {
      object[key] = null;
    } else if (type === 0x10) {
      object[key] = buffer.readInt32LE(index);
      index += 4;
    } else if (type === 0x13) {
      index += 16;
      object[key] = null;
    } else {
      throw new Error(`Unsupported BSON type 0x${type.toString(16)} on field ${key}`);
    }
  }
  return object;
}

export function connectMongo(url = "mongodb://127.0.0.1:27017") {
  const parsed = new URL(url);
  const port = Number(parsed.port || 27017);
  const host = parsed.hostname || "127.0.0.1";
  const socket = net.createConnection({ host, port });
  let buffer = Buffer.alloc(0);
  let requestId = 1;
  /** @type {{ resolve: Function, reject: Function }[]} */
  const pending = [];

  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const messageLength = buffer.readInt32LE(0);
      if (buffer.length < messageLength) return;
      const message = buffer.subarray(0, messageLength);
      buffer = buffer.subarray(messageLength);
      const waiter = pending.shift();
      if (!waiter) continue;
      try {
        const document = decodeDocument(message, 16 + 4 + 1);
        if (document.ok === 0 || document.ok === 0.0) {
          waiter.reject(new Error(document.errmsg || "Mongo command failed"));
        } else {
          waiter.resolve(document);
        }
      } catch (error) {
        waiter.reject(error);
      }
    }
  });
  socket.on("error", (error) => {
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });

  async function command(document) {
    await ready;
    const payload = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from([0]),
      encodeDocument(document),
    ]);
    const header = Buffer.alloc(16);
    const id = requestId++;
    header.writeInt32LE(16 + payload.length, 0);
    header.writeInt32LE(id, 4);
    header.writeInt32LE(0, 8);
    header.writeInt32LE(OP_MSG, 12);
    const response = new Promise((resolve, reject) => pending.push({ resolve, reject }));
    socket.write(Buffer.concat([header, payload]));
    return response;
  }

  return {
    async hello() {
      await command({ hello: 1, $db: "admin" });
    },
    command,
    close() {
      socket.end();
    },
  };
}
