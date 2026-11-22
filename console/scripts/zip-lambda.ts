// Packs dist-api/lambda.js as index.mjs into dist-api/lambda.zip (one file, deflate), so `console deploy` needs no `zip` binary.
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

const dir = new URL("../dist-api/", import.meta.url);
const name = Buffer.from("index.mjs");
const data = readFileSync(new URL("lambda.js", dir));
const packed = deflateRawSync(data);
const crc = crc32(data);

const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4); // version needed
local.writeUInt16LE(8, 8); // deflate
local.writeUInt32LE(crc, 14);
local.writeUInt32LE(packed.length, 18);
local.writeUInt32LE(data.length, 22);
local.writeUInt16LE(name.length, 26);

const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 4);
central.writeUInt16LE(20, 6);
central.writeUInt16LE(8, 10);
central.writeUInt32LE(crc, 16);
central.writeUInt32LE(packed.length, 20);
central.writeUInt32LE(data.length, 24);
central.writeUInt16LE(name.length, 28);

const offset = local.length + name.length + packed.length;
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(1, 8);
end.writeUInt16LE(1, 10);
end.writeUInt32LE(central.length + name.length, 12);
end.writeUInt32LE(offset, 16);

writeFileSync(new URL("lambda.zip", dir), Buffer.concat([local, name, packed, central, name, end]));
