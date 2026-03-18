'use strict';

const reportService  = require('../../services/Admin/reportService');
const ResponseHelper = require('../../utils/responseHelper');

/**
 * Extract the shared filter object from req.query.
 * All report endpoints accept the same query params:
 *   period      - today | this_week | this_month | custom | all  (default: all)
 *   startDate   - YYYY-MM-DD  (required when period=custom)
 *   endDate     - YYYY-MM-DD  (required when period=custom)
 *   zoneId      - integer
 *   search      - free text
 *   page        - integer (default: 1)
 *   limit       - integer (default: 20, max: 100)
 */
function extractFilters(req) {
    const { period, startDate, endDate, zoneId, search, page, limit } = req.query;
    return { period, startDate, endDate, zoneId, search, page, limit };
}

// ---------------------------------------------------------------------------
// 1. Top Services Report
// ---------------------------------------------------------------------------
async function getTopServicesReport(req, res) {
    const filters = extractFilters(req);
    const data    = await reportService.getTopServicesReport(filters);
    return ResponseHelper.success(res, 'Top Services Report', { filters, data });
}

// ---------------------------------------------------------------------------
// 2. Hourly Report
// ---------------------------------------------------------------------------
async function getHourlyReport(req, res) {
    const filters = extractFilters(req);
    const data    = await reportService.getHourlyReport(filters);
    return ResponseHelper.success(res, 'Hourly Report', { filters, data });
}

// ---------------------------------------------------------------------------
// 3. On Hold Report
// ---------------------------------------------------------------------------
async function getOnHoldReport(req, res) {
    const filters = extractFilters(req);
    const result  = await reportService.getOnHoldReport(filters);
    return ResponseHelper.success(res, 'On Hold Report', { filters, ...result });
}

// ---------------------------------------------------------------------------
// 4. Service Demand Report
// ---------------------------------------------------------------------------
async function getServiceDemandReport(req, res) {
    const filters = extractFilters(req);
    const data    = await reportService.getServiceDemandReport(filters);
    return ResponseHelper.success(res, 'Service Demand Report', { filters, data });
}

// ---------------------------------------------------------------------------
// 5. Top Performing Shops
// ---------------------------------------------------------------------------
async function getTopShopsReport(req, res) {
    const filters = extractFilters(req);
    const data    = await reportService.getTopShopsReport(filters);
    return ResponseHelper.success(res, 'Top Performing Shops Report', { filters, data });
}

// ---------------------------------------------------------------------------
// 6. Daily Earning Report
// ---------------------------------------------------------------------------
async function getDailyEarningReport(req, res) {
    const filters = extractFilters(req);
    const data    = await reportService.getDailyEarningReport(filters);
    return ResponseHelper.success(res, 'Daily Earning Report', { filters, data });
}

// ---------------------------------------------------------------------------
// 7. Daily Earning Report — by Zone
// ---------------------------------------------------------------------------
async function getDailyEarningByZoneReport(req, res) {
    const filters = extractFilters(req);
    const data    = await reportService.getDailyEarningByZoneReport(filters);
    return ResponseHelper.success(res, 'Daily Earning Report by Zone', { filters, data });
}

// ---------------------------------------------------------------------------
// 8. Daily Earning Report — by Shop
// ---------------------------------------------------------------------------
async function getDailyEarningByShopReport(req, res) {
    const filters = extractFilters(req);
    const data    = await reportService.getDailyEarningByShopReport(filters);
    return ResponseHelper.success(res, 'Daily Earning Report by Shop', { filters, data });
}

module.exports = {
    getTopServicesReport,
    getHourlyReport,
    getOnHoldReport,
    getServiceDemandReport,
    getTopShopsReport,
    getDailyEarningReport,
    getDailyEarningByZoneReport,
    getDailyEarningByShopReport
};
