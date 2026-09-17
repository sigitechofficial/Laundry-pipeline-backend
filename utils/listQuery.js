'use strict';

/**
 * Shared admin list-query contract.
 *
 * Every admin list endpoint that supports search / filters / CSV export reads
 * its query string through these helpers so the wire contract is identical
 * across modules:
 *
 *   ?search=      free text (trimmed, capped, leading "#" stripped)
 *   ?page= &limit= paginated window (clamped)
 *   ?sortBy= &sortDir=  allow-listed sort
 *   ?startDate= &endDate=  inclusive calendar-day range (YYYY-MM-DD)
 *   ?export=1     export window: page 1, limit EXPORT_MAX_ROWS. The response
 *                 pagination carries `exportMode: true` and `truncated` so the
 *                 client can warn when the cap was hit.
 *
 * Response pagination shape (all list endpoints):
 *   { currentPage, totalPages, totalRecords, recordsPerPage,
 *     hasNextPage, hasPrevPage, exportMode, truncated }
 */

const { Op } = require('sequelize');
const {
    clampListLimit,
    clampPage,
    DEFAULT_LIST_LIMIT,
    DEFAULT_MAX_LIST_LIMIT,
} = require('./listLimit');

/** Hard ceiling for a single export request. Above this the client is told `truncated`. */
const EXPORT_MAX_ROWS = 5000;
/** Longest search term we will turn into a LIKE pattern. */
const MAX_SEARCH_LENGTH = 120;

const TRUTHY = new Set(['1', 'true', 'yes', 'csv']);

/**
 * @param {Record<string, unknown>} query req.query
 * @returns {boolean}
 */
function isExportRequest(query = {}) {
    const raw = query.export ?? query.format;
    if (raw == null) return false;
    return TRUTHY.has(String(raw).trim().toLowerCase());
}

/**
 * Normalise a free-text search term. Returns '' when there is nothing to match.
 * @param {unknown} raw
 * @returns {string}
 */
function parseSearchTerm(raw) {
    if (raw == null) return '';
    const term = String(raw).trim().replace(/^#+/, '').trim();
    if (!term) return '';
    return term.length > MAX_SEARCH_LENGTH ? term.slice(0, MAX_SEARCH_LENGTH) : term;
}

/**
 * Escape LIKE wildcards in user input so "%" / "_" match literally.
 * @param {string} term
 */
function escapeLike(term) {
    return String(term).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Build a Sequelize `{ [Op.or]: [...] }` clause matching `term` against `fields`.
 * Fields may be plain columns ("email") or association paths ("$zone.zoneName$").
 * Numeric-looking terms also match `idFields` exactly.
 *
 * @param {string} term already normalised via parseSearchTerm
 * @param {string[]} fields
 * @param {{ idFields?: string[] }} [opts]
 * @returns {object|null} null when term is empty
 */
function buildSearchWhere(term, fields, opts = {}) {
    const clean = parseSearchTerm(term);
    if (!clean || !Array.isArray(fields) || fields.length === 0) return null;
    const like = `%${escapeLike(clean)}%`;
    const or = fields.map((field) => ({ [field]: { [Op.like]: like } }));
    if (/^\d+$/.test(clean) && Array.isArray(opts.idFields)) {
        const id = parseInt(clean, 10);
        for (const field of opts.idFields) or.push({ [field]: id });
    }
    return { [Op.or]: or };
}

/**
 * Merge a search clause into an existing where object without clobbering an
 * existing `Op.and` / `Op.or`.
 * @param {object} where
 * @param {object|null} searchWhere
 */
function andWhere(where, searchWhere) {
    if (!searchWhere) return where || {};
    const base = where || {};
    if (Object.keys(base).length === 0 && Object.getOwnPropertySymbols(base).length === 0) {
        return searchWhere;
    }
    const existingAnd = base[Op.and];
    if (Array.isArray(existingAnd)) {
        return { ...base, [Op.and]: [...existingAnd, searchWhere] };
    }
    return { ...base, [Op.and]: [searchWhere] };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Inclusive calendar-day range on a timestamp column.
 * Accepts YYYY-MM-DD (day boundaries) or a full ISO string.
 * Returns null when neither bound parses.
 *
 * @param {unknown} startRaw
 * @param {unknown} endRaw
 * @returns {object|null}
 */
function buildDateRangeWhere(startRaw, endRaw) {
    const range = {};
    if (startRaw) {
        const s = String(startRaw).trim();
        const start = new Date(DATE_ONLY.test(s) ? `${s}T00:00:00.000` : s);
        if (!Number.isNaN(start.getTime())) range[Op.gte] = start;
    }
    if (endRaw) {
        const e = String(endRaw).trim();
        const end = new Date(DATE_ONLY.test(e) ? `${e}T23:59:59.999` : e);
        if (!Number.isNaN(end.getTime())) range[Op.lte] = end;
    }
    return Object.getOwnPropertySymbols(range).length ? range : null;
}

/**
 * Resolve page / limit / offset, honouring export mode.
 *
 * @param {Record<string, unknown>} query req.query
 * @param {{ defaultLimit?: number, maxLimit?: number, exportMax?: number }} [opts]
 * @returns {{ page: number, limit: number, offset: number, exportMode: boolean }}
 */
function resolveListWindow(query = {}, opts = {}) {
    const exportMode = isExportRequest(query);
    if (exportMode) {
        const limit = Number.isFinite(opts.exportMax) && opts.exportMax > 0
            ? opts.exportMax
            : EXPORT_MAX_ROWS;
        return { page: 1, limit, offset: 0, exportMode: true };
    }
    const page = clampPage(query.page);
    const limit = clampListLimit(
        query.limit,
        opts.defaultLimit ?? DEFAULT_LIST_LIMIT,
        opts.maxLimit ?? DEFAULT_MAX_LIST_LIMIT
    );
    return { page, limit, offset: (page - 1) * limit, exportMode: false };
}

/**
 * Allow-listed sort. `allowed` maps public keys to Sequelize order entries
 * (a column name or an array like [ { model }, 'col' ]).
 *
 * @param {Record<string, unknown>} query
 * @param {Record<string, string|any[]>} allowed
 * @param {{ sortBy: string, sortDir?: 'ASC'|'DESC' }} fallback
 * @returns {{ sortBy: string, sortDir: 'ASC'|'DESC', order: any[] }}
 */
function resolveSort(query = {}, allowed = {}, fallback) {
    const requested = String(query.sortBy || '').trim();
    const sortBy = Object.prototype.hasOwnProperty.call(allowed, requested)
        ? requested
        : fallback.sortBy;
    const dirRaw = String(query.sortDir || '').trim().toUpperCase();
    const sortDir = dirRaw === 'ASC' || dirRaw === 'DESC'
        ? dirRaw
        : (fallback.sortDir || 'DESC');
    const target = allowed[sortBy] ?? fallback.sortBy;
    const order = Array.isArray(target) ? [[...target, sortDir]] : [[target, sortDir]];
    return { sortBy, sortDir, order };
}

/**
 * Standard pagination block for list responses.
 *
 * @param {number} totalRecords
 * @param {{ page: number, limit: number, exportMode: boolean }} window
 */
function buildPagination(totalRecords, window) {
    const total = Math.max(0, Number(totalRecords) || 0);
    const limit = Math.max(1, Number(window.limit) || 1);
    const page = Math.max(1, Number(window.page) || 1);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
        currentPage: page,
        totalPages,
        totalRecords: total,
        recordsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        exportMode: Boolean(window.exportMode),
        truncated: Boolean(window.exportMode) && total > limit,
    };
}

/**
 * In-memory list pipeline for endpoints whose rows are shaped in JS after a
 * full fetch (small reference tables). Applies search → sort → window and
 * returns the standard pagination block, so the wire contract matches the
 * SQL-backed lists.
 *
 * @template T
 * @param {T[]} rows
 * @param {Record<string, unknown>} query
 * @param {{
 *   searchFields: (string | ((row: T) => unknown))[],
 *   sortable?: Record<string, (row: T) => unknown>,
 *   defaultSort?: { sortBy: string, sortDir?: 'ASC'|'DESC' },
 *   defaultLimit?: number, maxLimit?: number, exportMax?: number,
 *   filter?: (row: T) => boolean,
 * }} opts
 * @returns {{ rows: T[], pagination: object, search: string }}
 */
function applyListQueryInMemory(rows, query = {}, opts) {
    const all = Array.isArray(rows) ? rows : [];
    const search = parseSearchTerm(query.search);
    const q = search.toLowerCase();

    const readField = (row, field) => (typeof field === 'function' ? field(row) : row?.[field]);
    const matches = (row) => {
        if (!q) return true;
        return opts.searchFields.some((field) => {
            const v = readField(row, field);
            if (v == null) return false;
            return String(v).toLowerCase().includes(q);
        });
    };

    let filtered = all.filter((row) => matches(row) && (opts.filter ? opts.filter(row) : true));

    if (opts.sortable && opts.defaultSort) {
        const { sortBy, sortDir } = resolveSort(
            query,
            Object.fromEntries(Object.keys(opts.sortable).map((k) => [k, k])),
            opts.defaultSort
        );
        const read = opts.sortable[sortBy];
        if (typeof read === 'function') {
            const dir = sortDir === 'ASC' ? 1 : -1;
            filtered = [...filtered].sort((a, b) => {
                const av = read(a);
                const bv = read(b);
                if (av == null && bv == null) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
                if (av instanceof Date || bv instanceof Date) {
                    return (new Date(av).getTime() - new Date(bv).getTime()) * dir;
                }
                return String(av).localeCompare(String(bv), undefined, {
                    sensitivity: 'base',
                    numeric: true,
                }) * dir;
            });
        }
    }

    const window = resolveListWindow(query, opts);
    const pagination = buildPagination(filtered.length, window);
    const paged = filtered.slice(window.offset, window.offset + window.limit);
    return { rows: paged, pagination, search };
}

module.exports = {
    EXPORT_MAX_ROWS,
    MAX_SEARCH_LENGTH,
    isExportRequest,
    parseSearchTerm,
    escapeLike,
    buildSearchWhere,
    andWhere,
    buildDateRangeWhere,
    resolveListWindow,
    resolveSort,
    buildPagination,
    applyListQueryInMemory,
};
