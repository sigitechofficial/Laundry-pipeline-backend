'use strict';

const reportService = require('../../services/Admin/reportService');
const ResponseHelper = require('../../utils/responseHelper');
const { zoneIdFromRequest } = require('../../utils/adminZoneScope');

/**
 * Shared allowlisted filters:
 *   period      - today | this_week | this_month | custom | all
 *   startDate   - YYYY-MM-DD (when period=custom)
 *   endDate     - YYYY-MM-DD (when period=custom)
 *   zoneId      - integer
 *   shopId      - laundryShopId (address id)
 *   search      - free text (max 80)
 *   page / limit
 */
function extractFilters(req) {
    const { period, startDate, endDate, shopId, search, page, limit } = req.query;
    return {
        period,
        startDate,
        endDate,
        zoneId: zoneIdFromRequest(req),
        shopId,
        search,
        page,
        limit,
    };
}

async function getTopServicesReport(req, res) {
    const data = await reportService.getTopServicesReport(extractFilters(req));
    return ResponseHelper.success(res, 'Top Services Report', data);
}

async function getHourlyReport(req, res) {
    const data = await reportService.getHourlyReport(extractFilters(req));
    return ResponseHelper.success(res, 'Hourly Report', data);
}

async function getOnHoldReport(req, res) {
    const data = await reportService.getOnHoldReport(extractFilters(req));
    return ResponseHelper.success(res, 'On Hold Report', data);
}

async function getServiceDemandReport(req, res) {
    const data = await reportService.getServiceDemandReport(extractFilters(req));
    return ResponseHelper.success(res, 'Service Demand Report', data);
}

async function getTopShopsReport(req, res) {
    const data = await reportService.getTopShopsReport(extractFilters(req));
    return ResponseHelper.success(res, 'Top Performing Shops Report', data);
}

async function getDailyEarningReport(req, res) {
    const data = await reportService.getDailyEarningReport(extractFilters(req));
    return ResponseHelper.success(res, 'Daily Earning Report', data);
}

async function getDailyEarningByZoneReport(req, res) {
    const data = await reportService.getDailyEarningByZoneReport(extractFilters(req));
    return ResponseHelper.success(res, 'Daily Earning Report by Zone', data);
}

async function getDailyEarningByShopReport(req, res) {
    const data = await reportService.getDailyEarningByShopReport(extractFilters(req));
    return ResponseHelper.success(res, 'Daily Earning Report by Shop', data);
}

async function getShopRatingsReport(req, res) {
    const data = await reportService.getShopRatingsReport({
        ...extractFilters(req),
        minReviews: req.query.minReviews,
        sort: req.query.sort,
    });
    return ResponseHelper.success(res, 'Shop Ratings Performance Report', data);
}

async function getReviewReasonInsights(req, res) {
    const data = await reportService.getReviewReasonInsights({
        ...extractFilters(req),
        sentiment: req.query.sentiment,
    });
    return ResponseHelper.success(res, 'Review Reason Insights', data);
}

async function getReasonShopBreakdown(req, res) {
    const data = await reportService.getReasonShopBreakdown({
        ...extractFilters(req),
        reasonCode: req.query.reasonCode || req.params.reasonCode,
    });
    return ResponseHelper.success(res, 'Reason Shop Breakdown', data);
}

async function getPaymentsReport(req, res) {
    const data = await reportService.getPaymentsReport(extractFilters(req));
    return ResponseHelper.success(res, 'Payments Report', data);
}

async function getCancellationsReport(req, res) {
    const data = await reportService.getCancellationsReport(extractFilters(req));
    return ResponseHelper.success(res, 'Cancellations Report', data);
}

async function getCustomersReport(req, res) {
    const data = await reportService.getCustomersReport(extractFilters(req));
    return ResponseHelper.success(res, 'Customers Report', data);
}

async function getDriversReport(req, res) {
    const data = await reportService.getDriversReport(extractFilters(req));
    return ResponseHelper.success(res, 'Drivers Report', data);
}

async function getOverdueReport(req, res) {
    const data = await reportService.getOverdueReport(extractFilters(req));
    return ResponseHelper.success(res, 'Overdue Report', data);
}

module.exports = {
    getTopServicesReport,
    getHourlyReport,
    getOnHoldReport,
    getServiceDemandReport,
    getTopShopsReport,
    getDailyEarningReport,
    getDailyEarningByZoneReport,
    getDailyEarningByShopReport,
    getShopRatingsReport,
    getReviewReasonInsights,
    getReasonShopBreakdown,
    getPaymentsReport,
    getCancellationsReport,
    getCustomersReport,
    getDriversReport,
    getOverdueReport,
};
