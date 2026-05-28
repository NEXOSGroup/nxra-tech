// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-bosch-glb.mjs — Clones DemoRealvirtualWeb.glb and rewrites the
 * AASLink on the "Motor" node so it references the Bosch Rexroth AAS
 * (instead of the Festo one). Writes DemoRealvirtualWebBosch.glb.
 *
 * Usage: node scripts/build-bosch-glb.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'public', 'models', 'DemoRealvirtualWeb.glb');
const DST = join(__dirname, '..', 'public', 'models', 'DemoRealvirtualWebBosch.glb');

const NEW_AAS_ID = 'https://aas.boschrexroth.com/ctrlxdrive/R911410072-MS2N-Demo-0001';
const NEW_DESCRIPTION = 'Bosch Rexroth ctrlX DRIVE - MS2N Servomotor';

const OLD_AAS_ID = 'http://smart.festo.com/aas/99920200617190044000012858';
const OLD_DESCRIPTION = 'Festo EMME-AS-40 Servo Motor';

// ── GLB chunk constants ──
const GLB_MAGIC = 0x46546C67;        // "glTF"
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4E4F534A;       // "JSON"
const CHUNK_BIN  = 0x004E4942;       // "BIN\0"

function readChunks(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  if (buf.readUInt32LE(4) !== GLB_VERSION) throw new Error('GLB version != 2');
  const chunks = [];
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 8 + len;
  }
  return chunks;
}

function padTo4(buf, pad) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem, pad)]);
}

function writeChunks(chunks) {
  let totalLen = 12;
  for (const c of chunks) totalLen += 8 + c.data.length;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(GLB_VERSION, 4);
  out.writeUInt32LE(totalLen, 8);
  let off = 12;
  for (const c of chunks) {
    out.writeUInt32LE(c.data.length, off);
    out.writeUInt32LE(c.type, off + 4);
    c.data.copy(out, off + 8);
    off += 8 + c.data.length;
  }
  return out;
}

const srcBuf = readFileSync(SRC);
console.log(`Source GLB: ${SRC} (${(srcBuf.length / 1024 / 1024).toFixed(1)} MB)`);

const chunks = readChunks(srcBuf);
const jsonChunk = chunks.find(c => c.type === CHUNK_JSON);
if (!jsonChunk) throw new Error('no JSON chunk');

let json = jsonChunk.data.toString('utf-8');

// Swap AAS ID + description (escape regex special chars on URL is sufficient)
const idOcc = json.split(OLD_AAS_ID).length - 1;
const descOcc = json.split(OLD_DESCRIPTION).length - 1;
console.log(`AAS-ID occurrences: ${idOcc}  Description occurrences: ${descOcc}`);
if (idOcc === 0) throw new Error('AAS ID not found in GLB JSON');

json = json.split(OLD_AAS_ID).join(NEW_AAS_ID);
json = json.split(OLD_DESCRIPTION).join(NEW_DESCRIPTION);

// JSON chunk must be 4-byte aligned, padded with spaces (0x20)
const newJsonChunk = {
  type: CHUNK_JSON,
  data: padTo4(Buffer.from(json, 'utf-8'), 0x20),
};

const newChunks = chunks.map(c => c.type === CHUNK_JSON ? newJsonChunk : c);
const outBuf = writeChunks(newChunks);
writeFileSync(DST, outBuf);
console.log(`Written: ${DST} (${(outBuf.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`New AAS-ID: ${NEW_AAS_ID}`);
console.log(`New description: ${NEW_DESCRIPTION}`);
