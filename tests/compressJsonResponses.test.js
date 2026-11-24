'use strict';

/**
 * middlewares/compressJsonResponses.js: JSON bodies are gzipped only for clients that accept
 * gzip and only above the threshold; everything else is byte-for-byte what Express sends.
 */
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const { compressJsonResponses } = require('../middlewares/compressJsonResponses');

const big = { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Booking ${i}`, status: 'Processing' })) };
const small = { status: '1', message: 'ok' };

const app = express();
app.use(compressJsonResponses());
app.get('/big', (req, res) => res.status(200).json(big));
app.get('/big-send-object', (req, res) => res.send(big));
app.get('/small', (req, res) => res.json(small));
app.get('/html', (req, res) => res.type('html').send('<p>' + 'x'.repeat(5000) + '</p>'));
app.get('/no-transform', (req, res) => {
    res.set('Cache-Control', 'no-transform');
    res.json(big);
});
app.get('/vary-origin', (req, res) => {
    res.set('Vary', 'Origin');
    res.json(big);
});
app.get('/empty', (req, res) => res.status(204).end());

function request(server, path, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: server.address().port, path, method, headers },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
        // Large JSON + gzip accepted → gzipped, same JSON after decompression, correct length.
        let { res, body } = await request(server, '/big', { headers: { 'accept-encoding': 'gzip' } });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['content-encoding'], 'gzip');
        assert.match(res.headers['content-type'], /^application\/json/);
        assert.match(res.headers.vary, /Accept-Encoding/);
        assert.strictEqual(Number(res.headers['content-length']), body.length);
        assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(body).toString('utf8')), big);
        assert.ok(body.length < JSON.stringify(big).length / 4, 'compressed body is much smaller');
        const etag = res.headers.etag;
        assert.ok(etag, 'ETag still set');

        // Conditional GET with that ETag still answers 304.
        ({ res } = await request(server, '/big', { headers: { 'accept-encoding': 'gzip', 'if-none-match': etag } }));
        assert.strictEqual(res.statusCode, 304);

        // res.send(object) goes through res.json internally and is compressed too.
        ({ res, body } = await request(server, '/big-send-object', { headers: { 'accept-encoding': 'gzip, deflate' } }));
        assert.strictEqual(res.headers['content-encoding'], 'gzip');
        assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(body).toString('utf8')), big);

        // No Accept-Encoding → identity body, but Vary still tells caches it could differ.
        ({ res, body } = await request(server, '/big'));
        assert.strictEqual(res.headers['content-encoding'], undefined);
        assert.match(res.headers.vary, /Accept-Encoding/);
        assert.deepStrictEqual(JSON.parse(body.toString('utf8')), big);

        // gzip explicitly refused (q=0) → identity.
        ({ res, body } = await request(server, '/big', { headers: { 'accept-encoding': 'gzip;q=0, identity' } }));
        assert.strictEqual(res.headers['content-encoding'], undefined);
        assert.deepStrictEqual(JSON.parse(body.toString('utf8')), big);

        // Below the threshold → identity.
        ({ res, body } = await request(server, '/small', { headers: { 'accept-encoding': 'gzip' } }));
        assert.strictEqual(res.headers['content-encoding'], undefined);
        assert.deepStrictEqual(JSON.parse(body.toString('utf8')), small);

        // Non-JSON responses are untouched (no encoding, no Vary added by us).
        ({ res, body } = await request(server, '/html', { headers: { 'accept-encoding': 'gzip' } }));
        assert.strictEqual(res.headers['content-encoding'], undefined);
        assert.ok(!/Accept-Encoding/i.test(res.headers.vary || ''));
        assert.ok(body.toString('utf8').startsWith('<p>'));

        // Cache-Control: no-transform is honoured.
        ({ res } = await request(server, '/no-transform', { headers: { 'accept-encoding': 'gzip' } }));
        assert.strictEqual(res.headers['content-encoding'], undefined);

        // An existing Vary is extended, not replaced.
        ({ res } = await request(server, '/vary-origin', { headers: { 'accept-encoding': 'gzip' } }));
        assert.strictEqual(res.headers.vary, 'Origin, Accept-Encoding');
        assert.strictEqual(res.headers['content-encoding'], 'gzip');

        // HEAD: headers only, no compression of an absent body.
        ({ res, body } = await request(server, '/big', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['content-encoding'], undefined);
        assert.strictEqual(body.length, 0);

        // 204 stays empty.
        ({ res, body } = await request(server, '/empty', { headers: { 'accept-encoding': 'gzip' } }));
        assert.strictEqual(res.statusCode, 204);
        assert.strictEqual(body.length, 0);

        console.log('compressJsonResponses tests passed');
    } finally {
        server.close();
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
