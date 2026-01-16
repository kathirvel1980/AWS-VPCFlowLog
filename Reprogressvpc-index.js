"use strict";

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const zlib = require("zlib");

const s3 = new S3Client({});

const ENV = {
    OUTPUT_PREFIX: process.env.OUTPUT_PREFIX || "VPCFlowLog/reprogressed/",
    EXPECTED_FIELD_COUNT: parseInt(process.env.EXPECTED_FIELD_COUNT || "25", 10),
    CHUNK_BYTES: parseInt(process.env.CHUNK_BYTES || (2 * 1024 * 1024), 10),
    FAIL_PREFIX: process.env.FAIL_PREFIX || "Process-Failed/"          // YOUR REAL PREFIX
};


// Convert stream -> Buffer
async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}


// Upload chunk to S3
async function uploadChunk(bucket, prefix, sourceKey, part, text) {
    const gz = zlib.gzipSync(Buffer.from(text, "utf8"));

    const safeName = sourceKey.replace(/\//g, "_");
    const newKey = `${prefix}${safeName}-part${part}.csv.gz`;

    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: newKey,
        Body: gz,
        ContentType: "text/csv",
        ContentEncoding: "gzip"
    }));

    console.log("Uploaded:", newKey);
}


// MAIN PROCESSOR
async function processFailedObject(bucket, key) {
    console.log(`Processing start: s3://${bucket}/${key}`);

    // Download the file
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await streamToBuffer(obj.Body);

    // Unzip if needed
    let payloadText = "";
    try {
        payloadText = zlib.gunzipSync(buf).toString("utf8");
    } catch {
        payloadText = buf.toString("utf8");
    }

    // ---------------------------------------------
    // 1) DETECT JSON WRAPPER vs RAW CSV
    // ---------------------------------------------
    let isJson = false;
    const trimmed = payloadText.trim();

    if (trimmed.startsWith("{")) {
        try {
            JSON.parse(trimmed);      // Check valid JSON
            isJson = true;
        } catch {
            isJson = false;
        }
    }

    // =============================================
    // CASE 1 — RAW CSV / CSV.GZ (Firehose failed)
    // =============================================
    if (!isJson) {
        console.log("Detected CSV.gz failed file → re-chunking.");

        const lines = payloadText.split(/\r?\n/).filter(Boolean);

        let part = 0;
        let chunk = [];
        let bytes = 0;

        for (const line of lines) {
            const fields = line.split(/\s+/);

            if (fields.length !== ENV.EXPECTED_FIELD_COUNT) {
                console.warn(`Skipping malformed CSV line: ${line.slice(0,120)}...`);
                continue;
            }

            const normalized = fields.join(" ");
            const size = Buffer.byteLength(normalized + "\n", "utf8");

            if (size > ENV.CHUNK_BYTES) {
                await uploadChunk(bucket, ENV.OUTPUT_PREFIX, key, part++, normalized + "\n");
                continue;
            }

            if (bytes + size > ENV.CHUNK_BYTES) {
                await uploadChunk(bucket, ENV.OUTPUT_PREFIX, key, part++, chunk.join("\n") + "\n");
                chunk = [];
                bytes = 0;
            }

            chunk.push(normalized);
            bytes += size;
        }

        if (chunk.length > 0) {
            await uploadChunk(bucket, ENV.OUTPUT_PREFIX, key, part++, chunk.join("\n") + "\n");
        }

        console.log("CSV processing finished");
        return;
    }

    // =============================================
    // CASE 2 — JSON WRAPPER (CloudWatch Logs)
    // =============================================
    let wrapper;
    try {
        wrapper = JSON.parse(payloadText);
    } catch (e) {
        console.error("Invalid wrapper JSON:", e);
        return;
    }

    if (wrapper.messageType !== "DATA_MESSAGE") {
        console.log("Skipping non-DATA_MESSAGE");
        return;
    }

    const logEvents = wrapper.logEvents || [];

    let chunk = [];
    let bytes = 0;
    let part = 0;

    for (const le of logEvents) {
        const raw = (le.message || "").trim();
        if (!raw || raw.includes("NODATA")) continue;

        const fields = raw.split(/\s+/);
        if (fields.length !== ENV.EXPECTED_FIELD_COUNT) continue;

        const outLine = fields.join(" ");
        const size = Buffer.byteLength(outLine + "\n", "utf8");

        if (size > ENV.CHUNK_BYTES) {
            await uploadChunk(bucket, ENV.OUTPUT_PREFIX, key, part++, outLine + "\n");
            continue;
        }

        if (bytes + size > ENV.CHUNK_BYTES) {
            await uploadChunk(bucket, ENV.OUTPUT_PREFIX, key, part++, chunk.join("\n") + "\n");
            chunk = [];
            bytes = 0;
        }

        chunk.push(outLine);
        bytes += size;
    }

    if (chunk.length > 0) {
        await uploadChunk(bucket, ENV.OUTPUT_PREFIX, key, part++, chunk.join("\n") + "\n");
    }

    console.log("JSON wrapper processing finished");
}


// EXTRACT S3 EVENTS
function extractS3Events(rec) {
    // Direct S3 → Lambda
    if (rec.s3 && rec.s3.bucket && rec.s3.object) {
        return [{ bucket: rec.s3.bucket.name, key: decodeURIComponent(rec.s3.object.key) }];
    }

    // S3 → SQS → Lambda
    try {
        const bodyObj = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;
        if (bodyObj?.Records) {
            return bodyObj.Records
                .filter(r => r.s3)
                .map(r => ({ bucket: r.s3.bucket.name, key: decodeURIComponent(r.s3.object.key) }));
        }
    } catch {}

    return [];
}


// LAMBDA HANDLER
exports.handler = async (event) => {
    console.log("Lambda invoked, incoming event:", JSON.stringify(event));

    for (const rec of event.Records || []) {
        const s3recs = extractS3Events(rec);

        for (const s3event of s3recs) {
            if (!s3event.key.startsWith(ENV.FAIL_PREFIX)) {
                console.log(`Skipping: ${s3event.key} (does not match FAIL_PREFIX ${ENV.FAIL_PREFIX})`);
                continue;
            }

            await processFailedObject(s3event.bucket, s3event.key);
        }
    }

    return { status: "done" };
};
