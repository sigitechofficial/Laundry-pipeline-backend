'use strict';

const zlib = require('zlib');

/**
 * Gzip JSON API responses for clients that accept gzip.
 *
 * Why: the API is served through Apache on a host ~250 ms round-trip from the apps, and
 * Apache passes the Node response through uncompressed. Board/catalog/history responses
 * of 50–110 KB then need several extra round trips of TCP slow start (measured on stage:
 * 1.5–2.9 s of transfer after the first byte). Their JSON compresses about 12–14x, so the
 * gzipped body fits in the first congestion window.
 *
 * Scope: only bodies sent through res.send / res.json whose Content-Type is JSON. Files,
 * streams (express.static, swagger-ui) and Socket.IO are untouched. The agent and customer
 * apps (dart:io HttpClient) send `Accept-Encoding: gzip` and decompress transparently;
 * browsers do the same. Clients that do not accept gzip get the identity body.
 *
 * @param {{ threshold?: number, level?: number }} [options]
 *   threshold: bodies smaller than this many bytes are sent as-is (default 1024 — below one
 *   TCP segment compression saves nothing on the wire).
 *   level: zlib compression level (default zlib.constants.Z_DEFAULT_COMPRESSION).
 */
function compressJsonResponses(options = {}) {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 1024;
    const level = Number.isFinite(options.level) ? options.level : zlib.constants.Z_DEFAULT_COMPRESSION;

    return function compressJsonResponsesMiddleware(req, res, next) {
        const send = res.send;

        res.send = function sendMaybeCompressed(body) {
            // res.send(object) makes Express call res.json → res.send(string): stay
            // installed so that second call (the serialized JSON) comes back here.
            if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
                return send.call(this, body);
            }
            // Restore first so the final send below goes straight to Express.
            res.send = send;

            if (!isJsonResponse(res)) {
                return send.call(this, body);
            }
            appendVary(res, 'Accept-Encoding');

            if (!shouldCompress(req, res, body, threshold)) {
                return send.call(this, body);
            }

            const input = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
            zlib.gzip(input, { level }, (err, gzipped) => {
                if (err) {
                    // Compression is optional in HTTP; the identity body is a correct answer.
                    console.error(`[compressJsonResponses] gzip failed for ${req.method} ${req.originalUrl}: ${err.message}`);
                    return send.call(res, body);
                }
                res.setHeader('Content-Encoding', 'gzip');
                return send.call(res, gzipped);
            });
            return res;
        };

        next();
    };
}

function isJsonResponse(res) {
    const type = String(res.getHeader('Content-Type') || '').toLowerCase();
    return /^application\/(?:[\w.+-]+\+)?json\b/.test(type);
}

function shouldCompress(req, res, body, threshold) {
    if (req.method === 'HEAD') return false;
    if (res.statusCode === 204 || res.statusCode === 304) return false;
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) return false;
    if (res.getHeader('Content-Encoding')) return false;
    if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') || ''))) return false;
    if (Buffer.byteLength(body) < threshold) return false;
    return req.acceptsEncodings('gzip', 'identity') === 'gzip';
}

function appendVary(res, field) {
    const current = res.getHeader('Vary');
    if (!current) {
        res.setHeader('Vary', field);
        return;
    }
    const fields = String(current).split(',').map((f) => f.trim().toLowerCase());
    if (fields.includes('*') || fields.includes(field.toLowerCase())) return;
    res.setHeader('Vary', `${current}, ${field}`);
}

module.exports = { compressJsonResponses };
