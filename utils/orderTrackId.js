"use strict";

const otpGenerator = require("otp-generator");

function generateOrderTrackId(bookingId) {
    const suffix = otpGenerator.generate(6, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: false,
    });
    return `${bookingId}-${suffix}`;
}

function hasFullOrderTrackId(value) {
    const s = String(value || "").trim();
    return /^\d+-\d{4,}$/.test(s);
}

function readOrderTrackId(row) {
    if (!row) return "";
    if (typeof row.get === "function") {
        return row.get("orderTrackId");
    }
    return row.orderTrackId;
}

function readBookingId(row) {
    if (!row) return null;
    if (typeof row.get === "function") return row.get("id");
    return row.id;
}

function writeOrderTrackId(row, orderTrackId) {
    if (!row) return;
    if (typeof row.set === "function") {
        row.set("orderTrackId", orderTrackId);
        return;
    }
    row.orderTrackId = orderTrackId;
}

/**
 * Persist `{id}-{6 digits}` as soon as the booking row exists.
 * Safe to call again — skips rows that already have a full track id.
 */
async function ensureOrderTrackId(bookingModel, row) {
    if (!bookingModel || !row) return null;
    const current = readOrderTrackId(row);
    if (hasFullOrderTrackId(current)) return String(current).trim();
    const id = Number(readBookingId(row));
    if (!Number.isFinite(id) || id <= 0) return current || null;
    const orderTrackId = generateOrderTrackId(id);
    await bookingModel.update({ orderTrackId }, { where: { id } });
    writeOrderTrackId(row, orderTrackId);
    return orderTrackId;
}

async function ensureOrderTrackIds(bookingModel, rows = []) {
    const list = Array.isArray(rows) ? rows : [];
    const missing = list.filter((row) => !hasFullOrderTrackId(readOrderTrackId(row)));
    if (missing.length === 0) return list;
    await Promise.all(missing.map((row) => ensureOrderTrackId(bookingModel, row)));
    return list;
}

module.exports = {
    generateOrderTrackId,
    hasFullOrderTrackId,
    ensureOrderTrackId,
    ensureOrderTrackIds,
};
