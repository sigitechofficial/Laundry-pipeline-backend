'use strict';

/**
 * Customer photos of where bags are left for "Collect from Outside" pickups.
 * Always optional on the server: older customer apps never send them.
 */

const COLLECT_FROM_OUTSIDE = 'Collect from Outside';
const COLLECTION_IMAGE_DIR = 'Public/collectionImages/';
const MAX_COLLECTION_IMAGES = 3;

/**
 * Keep only paths our upload endpoint produced (Public/collectionImages/<file>),
 * de-duplicated and capped. Anything else is dropped silently.
 */
function normalizeCollectionImageUrls(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        const url = String(item || '').trim().replace(/\\/g, '/');
        if (!url.startsWith(COLLECTION_IMAGE_DIR)) continue;
        const fileName = url.slice(COLLECTION_IMAGE_DIR.length);
        if (!fileName || fileName.includes('/') || fileName.includes('..')) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= MAX_COLLECTION_IMAGES) break;
    }
    return out;
}

function isCollectFromOutside(driverInstructionOptions) {
    return String(driverInstructionOptions || '').trim() === COLLECT_FROM_OUTSIDE;
}

async function saveCollectionImages(bookingId, urls, options = {}) {
    const clean = normalizeCollectionImageUrls(urls);
    if (!bookingId || clean.length === 0) return [];
    const { bookingCollectionImage } = require('../models');
    return bookingCollectionImage.bulkCreate(
        clean.map((imageUrl, idx) => ({ bookingId, imageUrl, sortOrder: idx + 1 })),
        options
    );
}

async function getCollectionImages(bookingId) {
    if (!bookingId) return [];
    const { bookingCollectionImage } = require('../models');
    const rows = await bookingCollectionImage.findAll({
        where: { bookingId },
        attributes: ['id', 'imageUrl', 'sortOrder'],
        order: [['sortOrder', 'ASC'], ['id', 'ASC']],
        raw: true,
    });
    return rows;
}

/** Same as getCollectionImages, but never throws (detail screens must still load). */
async function getCollectionImagesSafe(bookingId, logTag = 'collectionImages') {
    try {
        return await getCollectionImages(bookingId);
    } catch (err) {
        console.warn(`[${logTag}] collection images skipped for booking ${bookingId}:`, err?.message || err);
        return [];
    }
}

module.exports = {
    COLLECT_FROM_OUTSIDE,
    COLLECTION_IMAGE_DIR,
    MAX_COLLECTION_IMAGES,
    normalizeCollectionImageUrls,
    isCollectFromOutside,
    saveCollectionImages,
    getCollectionImages,
    getCollectionImagesSafe,
};
