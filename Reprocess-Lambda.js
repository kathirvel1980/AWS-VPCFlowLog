"use strict";

/**
 * FULL LAMBDA - VPC Flow Log Reprocessor
 * - Supports Firehose ProcessingFailed NDJSON
 * - Base64 decode + gunzip rawData
 * - Extract CloudWatch Logs wrapper messages
 * - Validate 25 fields (space-delimited)
 * - Add header to each chunk
 * - Rechunk to 4 MB chunks
 * - Compress to .csv.gz
 * - Upload to same bucket → OUTPUT_PREFIX
 */

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const zlib = require("zlib");
const crypto = require("crypto");

const s3 = new S3Client({});

// Environment variables
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || "VPCFlowLog/reprogressed/";
const FAIL_PREFIX = process.env.FAIL_PREFIX || "Process-Failed/";
const EXPECTED_FIELDS = parseInt(process.env.EXPECTED_FIELDS || "25", 10);
const CHUNK_BYTES = parseInt(process.env.CHUNK_BYTES || String(4 * 1024 * 1024), 10); // 4 MB

// Header fields for VPC Flow Logs (25 fields)
const HEADER_FIELDS = [
  "version","account-id","interface-id","srcaddr","dstaddr","srcport",
  "dstport","protocol","packets","bytes","start","end","action",
  "log-status","vpc-id","subnet-id","instance-id","tcp-flags","type",
  "pkt-srcaddr","pkt-dstaddr","region","az-id","sublocation-type","sublocation-id"
];
const HEADER_LINE = HEADER_FIELDS.join(" ");

// ---------------- HELPER FUNCTIONS ----------------

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function tryJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function decodeRawDataB64(rawB64) {
  try {
    const buf = Buffer.from(rawB64, "base64");
    return zlib.gunzipSync(buf).toString("utf8");
  } catch {
    return null;
  }
}

function normalizeFlowLine(line) {
  if (!line) return null;
  const fields = line.trim().split(/\s+/);
  if (fields.length !== EXPECTED_FIELDS) return null;
  return fields.join(" ");
}

function extractWrapperMessages(wrapper) {
  if (!wrapper) return [];
  if (wrapper.messageType === "DATA_MESSAGE" && Array.isArray(wrapper.logEvents)) {
    return wrapper.logEvents
      .map(e => (e && e.message ? String(e.message).trim() : ""))
      .filter(Boolean);
  }
  return [];
}

// Short key to avoid Windows 259-char path limit
function buildShortKey(sourceKey, partIndex) {
  const hash = crypto.createHash("sha1").update(sourceKey).digest("hex").substring(0, 16);
  return `${OUTPUT_PREFIX}${hash}-p${partIndex}.csv.gz`;
}

// Upload compressed chunk
async function uploadChunk(bucket, sourceKey, partIndex, text) {
  const gz = zlib.gzipSync(Buffer.from(text, "utf8"));
  const newKey = buildShortKey(sourceKey, partIndex);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: newKey,
    Body: gz,
    ContentType: "application/gzip" // DO NOT add ContentEncoding
  }));

  console.log(`Uploaded chunk: s3://${bucket}/${newKey} (${gz.length} bytes)`);
}

// ---------------- MAIN PROCESSOR ----------------

async function processFailedObject(bucket, key) {
  console.log(`Processing: s3://${bucket}/${key}`);

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buf = await streamToBuffer(obj.Body);

  // Detect gzip
  let text;
  try {
    text = zlib.gunzipSync(buf).toString("utf8");
  } catch {
    text = buf.toString("utf8");
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  console.log(`Total NDJSON/raw lines: ${lines.length}`);

  let part = 0;
  let currentLines = [HEADER_LINE];
  let currentBytes = Buffer.byteLength(HEADER_LINE + "\n", "utf8");

  async function flush(force) {
    if (currentLines.length <= 1 && !force) return;

    const csvText = currentLines.join("\n") + "\n";
    await uploadChunk(bucket, key, part++, csvText);

    currentLines = [HEADER_LINE];
    currentBytes = Buffer.byteLength(HEADER_LINE + "\n", "utf8");
  }

  // ---------------- Process each line ----------------
  for (const ln of lines) {
    const parsed = tryJSON(ln);

    // NDJSON Firehose style: { "rawData": "<base64>" }
    if (parsed && parsed.rawData) {
      const decoded = decodeRawDataB64(parsed.rawData);
      if (!decoded) continue;

      const wrapper = tryJSON(decoded);
      let messages = [];

      if (wrapper) {
        messages = extractWrapperMessages(wrapper);
      } else {
        messages = decoded.split(/\r?\n/).filter(Boolean);
      }

      for (const msg of messages) {
        const norm = normalizeFlowLine(msg);
        if (!norm) continue;

        const b = Buffer.byteLength(norm + "\n");
        if (currentBytes + b > CHUNK_BYTES) await flush(true);

        currentLines.push(norm);
        currentBytes += b;
      }

      continue;
    }

    // CloudWatch wrapper JSON (DATA_MESSAGE)
    if (parsed && parsed.messageType === "DATA_MESSAGE") {
      const msgs = extractWrapperMessages(parsed);

      for (const msg of msgs) {
        const norm = normalizeFlowLine(msg);
        if (!norm) continue;

        const b = Buffer.byteLength(norm + "\n");
        if (currentBytes + b > CHUNK_BYTES) await flush(true);

        currentLines.push(norm);
        currentBytes += b;
      }
      continue;
    }

    // Direct flow log line
    const norm = normalizeFlowLine(ln);
    if (!norm) continue;

    const b = Buffer.byteLength(norm + "\n");
    if (currentBytes + b > CHUNK_BYTES) await flush(true);

    currentLines.push(norm);
    currentBytes += b;
  }

  // Final flush
  await flush(true);

  console.log(`Completed: ${part} chunk(s) created`);
  return part;
}

// ---------------- LAMBDA HANDLER ----------------

exports.handler = async (event) => {
  console.log("EVENT:", JSON.stringify(event));

  if (!event.Records) return { processed: 0 };

  let processed = 0;

  for (const rec of event.Records) {
    const s3rec = rec.s3;
    if (!s3rec || !s3rec.bucket || !s3rec.object) continue;

    const bucket = s3rec.bucket.name;
    const key = decodeURIComponent(s3rec.object.key);

    if (!key.startsWith(FAIL_PREFIX)) {
      console.log(`Skipping ${key} (does not match prefix ${FAIL_PREFIX})`);
      continue;
    }

    try {
      await processFailedObject(bucket, key);
      processed++;
    } catch (e) {
      console.error(`Error processing ${key}:`, e);
    }
  }

  return { processed };
};
