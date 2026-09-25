const {
    booking,
    addressDb,
    bussinessInformation,
    bookingHistory,
    proofOfDeliveries,
    zone,
    sequelize,
} = require("../../models");
const { ValidationError, NotFoundError } = require("../../middlewares/universalErrorHandler");
const { Op } = require("sequelize");
const {
    COMPLETED,
    RETURNING_CUSTOMER_MIN_COMPLETED,
} = require("../../constants/bookingStatusIds");
const {
    isShopScheduleOpenNow,
    getWallClockContextForCountry,
    findTodayWorkingHoursRow,
} = require("../../utils/shopWorkingHours");
const {
    canAdminAssignOrReassignBooking,
    getAdminAssignBlockedReason,
    isAgentAcceptExpired,
} = require("../../utils/bookingAgentWindow");
const {
    getCountryContextFromZoneId,
} = require("../../utils/countryTimeZone");
const {
    BUSINESS_TIME_ZONE,
} = require("../../utils/bookingTimeZone");
const agentBookingDeclineService = require("../Agent/agentBookingDeclineService");
const { notifyAdminBookingAssignment } = require("../../utils/bookingAdminAssignNotify");
const { notifyBookingTakenByAgent } = require("../../utils/bookingTakenNotify");

class AdminBookingAssignService {
    async getAssignableShops(bookingId) {
        const bookingRow = await booking.findByPk(bookingId, {
            attributes: [
                "id",
                "zoneId",
                "bookingStatusId",
                "laundryShopId",
                "adminAssignedShopId",
                "invoiceStatus",
                "agentBroadcastHeld",
                "agentVisibleAt",
                "createdAt",
                "orderExpireTime",
                "placedOutsidePlatformHours",
                "orderTrackId",
                "customerId",
                "collectionDate",
                "collectionTimeFrom",
                "collectionTimeTo",
            ],
            include: [
                {
                    model: zone,
                    attributes: ["id", "name"],
                    required: false,
                    paranoid: false,
                },
            ],
        });

        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        if (bookingRow.zoneId == null) {
            throw new ValidationError(
                "This order has no zone. Assign a zone before selecting a shop."
            );
        }

        const orderZoneId = Number(bookingRow.zoneId);
        let zoneRow = bookingRow.zone || null;
        if (!zoneRow?.name) {
            zoneRow = await zone.findByPk(orderZoneId, {
                attributes: ["id", "name"],
                paranoid: false,
            });
        }
        let zoneName =
            (zoneRow?.name && String(zoneRow.name).trim()) || null;
        if (!zoneName) {
            try {
                const rows = await sequelize.query(
                    "SELECT id, name FROM zones WHERE id = :id LIMIT 1",
                    {
                        replacements: { id: orderZoneId },
                        type: sequelize.QueryTypes.SELECT,
                    }
                );
                const row = Array.isArray(rows) ? rows[0] : rows;
                if (row?.name) zoneName = String(row.name).trim();
            } catch (_) {
                /* ignore — UI can still resolve name from getZones */
            }
        }

        const countryCtx = await getCountryContextFromZoneId(bookingRow.zoneId);
        const assignBlockedReason = getAdminAssignBlockedReason(bookingRow);
        if (assignBlockedReason) {
            throw new ValidationError(
                `This order cannot be assigned. ${assignBlockedReason}`
            );
        }

        const wallClock = await getWallClockContextForCountry(
            countryCtx.countryId
        );
        const todayDayOfWeek = wallClock.dayOfWeek;

        // Strict zone filter — only laundry shops that belong to this booking's zone.
        const shops = await addressDb.findAll({
            where: {
                zoneId: orderZoneId,
                addressType: "LaundaryShopAddress",
                status: true,
            },
            attributes: ["id", "userId", "zoneId", "status"],
        });

        // Returning-customer signal per shop: absolute COMPLETED + TOTAL order
        // counts for this customer at each candidate shop (includes this booking
        // when it is already completed / assigned here — so the number matches
        // what the admin sees in the customer's completed list).
        const ordersAtShopMap = new Map();
        const totalOrdersAtShopMap = new Map();
        try {
            const shopIds = shops.map((s) => s.id);
            if (bookingRow.customerId && shopIds.length) {
                const [completedGrouped, totalGrouped] = await Promise.all([
                    booking.count({
                        where: {
                            customerId: bookingRow.customerId,
                            laundryShopId: { [Op.in]: shopIds },
                            bookingStatusId: COMPLETED,
                        },
                        group: ["laundryShopId"],
                    }),
                    booking.count({
                        where: {
                            customerId: bookingRow.customerId,
                            laundryShopId: { [Op.in]: shopIds },
                        },
                        group: ["laundryShopId"],
                    }),
                ]);
                (Array.isArray(completedGrouped) ? completedGrouped : []).forEach((row) => {
                    ordersAtShopMap.set(Number(row.laundryShopId), Number(row.count) || 0);
                });
                (Array.isArray(totalGrouped) ? totalGrouped : []).forEach((row) => {
                    totalOrdersAtShopMap.set(Number(row.laundryShopId), Number(row.count) || 0);
                });
            }
        } catch (err) {
            console.warn(
                `[getAssignableShops] returning-customer counts unavailable for booking ${bookingRow.id}:`,
                err?.message || err
            );
        }

        // Full cross-zone order history for this customer — absolute counts
        // (no exclude) so completed totals match the customer's order list.
        const customerShopHistory = await this.getCustomerShopHistory(
            bookingRow.customerId,
            null
        );

        const shopList = [];
        for (const shop of shops) {
            if (Number(shop.zoneId) !== orderZoneId) {
                continue;
            }
            const ownerId = shop.userId;
            const openNow = await isShopScheduleOpenNow(
                ownerId,
                countryCtx.countryId
            );
            const hoursRow = await findTodayWorkingHoursRow(
                ownerId,
                todayDayOfWeek
            );
            const biz = await bussinessInformation.findOne({
                where: { shopAddressId: shop.id },
                attributes: ["shopName"],
            });
            const isCurrentShop =
                bookingRow.laundryShopId != null &&
                Number(bookingRow.laundryShopId) === Number(shop.id);
            const customerOrdersAtShop = ordersAtShopMap.get(Number(shop.id)) || 0;
            const customerTotalOrdersAtShop = totalOrdersAtShopMap.get(Number(shop.id)) || 0;
            shopList.push({
                laundryShopId: shop.id,
                userId: ownerId,
                zoneId: orderZoneId,
                zoneName,
                shopName: biz?.shopName || `Shop #${shop.id}`,
                isOpenNow: openNow,
                canAssign: !isCurrentShop,
                isCurrentShop,
                customerOrdersAtShop,
                customerTotalOrdersAtShop,
                isReturningCustomerAtShop:
                    customerOrdersAtShop >= RETURNING_CUSTOMER_MIN_COMPLETED,
                todayDayOfWeek,
                todayOpenTime: hoursRow?.openTime || null,
                todayCloseTime: hoursRow?.closeTime || null,
                todayScheduleActive: Boolean(hoursRow?.status),
            });
        }

        // Ordering priority:
        //  1. The shop the order is CURRENTLY assigned to always sits at the top
        //     so the admin sees "who has it now" (and whether they're a returning
        //     customer there) before considering a move.
        //  2. Then shops where this customer has the most completed orders
        //     (strongest repeat business → most sensible reassign target).
        //  3. Then alphabetical for a stable, predictable list.
        shopList.sort((a, b) => {
            if (Boolean(a.isCurrentShop) !== Boolean(b.isCurrentShop)) {
                return a.isCurrentShop ? -1 : 1;
            }
            if ((b.customerOrdersAtShop || 0) !== (a.customerOrdersAtShop || 0)) {
                return (b.customerOrdersAtShop || 0) - (a.customerOrdersAtShop || 0);
            }
            return String(a.shopName).localeCompare(String(b.shopName), undefined, {
                sensitivity: "base",
            });
        });

        const expired = isAgentAcceptExpired(bookingRow, countryCtx.ianaTimeZone);

        return {
            bookingId: bookingRow.id,
            orderTrackId: bookingRow.orderTrackId,
            invoiceStatus: bookingRow.invoiceStatus,
            zoneId: orderZoneId,
            zoneName,
            currentLaundryShopId: bookingRow.laundryShopId,
            bookingStatusId: bookingRow.bookingStatusId,
            adminAssignedShopId: bookingRow.adminAssignedShopId,
            agentAcceptExpired: expired,
            collectionDate: bookingRow.collectionDate,
            collectionTimeFrom: bookingRow.collectionTimeFrom,
            collectionTimeTo: bookingRow.collectionTimeTo,
            shopCount: shopList.length,
            shops: shopList,
            customerShopHistory,
        };
    }

    async assignBookingToShop(bookingId, laundryShopId) {
        const bookingRow = await booking.findByPk(bookingId);
        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        const assignBlockedReason = getAdminAssignBlockedReason(bookingRow);
        if (assignBlockedReason) {
            throw new ValidationError(
                `Order cannot be assigned: ${assignBlockedReason}`
            );
        }

        if (bookingRow.zoneId == null) {
            throw new ValidationError(
                "This order has no zone. Assign a zone before selecting a shop."
            );
        }

        const orderZoneId = Number(bookingRow.zoneId);
        const shop = await addressDb.findOne({
            where: {
                id: laundryShopId,
                addressType: "LaundaryShopAddress",
                zoneId: orderZoneId,
                status: true,
            },
            attributes: ["id", "userId", "zoneId"],
        });

        if (!shop || Number(shop.zoneId) !== orderZoneId) {
            throw new NotFoundError(
                "Shop not found in this booking zone or invalid shop address."
            );
        }

        if (
            bookingRow.laundryShopId != null &&
            Number(bookingRow.laundryShopId) === Number(shop.id)
        ) {
            throw new ValidationError(
                "This order is already assigned to the selected shop."
            );
        }

        const ownerId = shop.userId;

        let previousOwnerUserId = null;
        if (bookingRow.laundryShopId) {
            const previousShop = await addressDb.findByPk(
                bookingRow.laundryShopId,
                { attributes: ["id", "userId"] }
            );
            previousOwnerUserId = previousShop?.userId || null;
        } else if (bookingRow.adminAssignedShopId) {
            const pendingShop = await addressDb.findByPk(
                bookingRow.adminAssignedShopId,
                { attributes: ["id", "userId"] }
            );
            previousOwnerUserId = pendingShop?.userId || null;
        }

        const isReassign =
            bookingRow.laundryShopId != null &&
            Number(bookingRow.bookingStatusId) !== 1;

        if (isReassign) {
            await proofOfDeliveries.destroy({ where: { bookingId } });
        }

        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const timeStr = now.toTimeString().slice(0, 8);

        await booking.update(
            {
                laundryShopId: shop.id,
                bookingStatusId: 3,
                driverId: ownerId || null,
                adminAssignedShopId: null,
                agentBroadcastHeld: false,
                agentVisibleAt: null,
            },
            { where: { id: bookingId } }
        );

        try {
            const { lockBookingRateSnapshot } = require("../../utils/bookingRateSnapshot");
            await lockBookingRateSnapshot(bookingId, { source: "assigned" });
        } catch (snapErr) {
            console.error(
                "[assignBookingToShop] rate snapshot lock failed:",
                snapErr.message
            );
        }

        try {
            const { syncLiveTrackingForBookingStatus } = require('../../utils/liveTrackingRtdb');
            // Close any active trip tracking when admin reassigns shop/driver.
            syncLiveTrackingForBookingStatus(bookingId, 3, {
                reason: 'admin_reassign',
            }).catch(() => {});
        } catch (_) { /* ignore */ }

        if (Number(bookingRow.bookingStatusId) === 1) {
            await bookingHistory.bulkCreate(
                [2, 3].map((statusId) => ({
                    bookingId,
                    bookingStatusId: statusId,
                    date: dateStr,
                    time: timeStr,
                }))
            );
        }

        const biz = await bussinessInformation.findOne({
            where: { shopAddressId: shop.id },
            attributes: ["shopName"],
        });

        await agentBookingDeclineService.clearDeclinesForBooking(bookingId);

        await notifyBookingTakenByAgent({
            bookingId,
            zoneId: bookingRow.zoneId,
            assignedUserId: ownerId,
            source: "admin",
            excludeUserIds: previousOwnerUserId ? [previousOwnerUserId] : [],
        });

        await notifyAdminBookingAssignment({
            bookingId,
            orderTrackId: bookingRow.orderTrackId,
            customerId: bookingRow.customerId,
            previousOwnerUserId,
            isReassign,
        });

        return {
            bookingId,
            laundryShopId: shop.id,
            bookingStatusId: 3,
            shopName: biz?.shopName || null,
            isReassign,
            paymentRetained: Boolean(bookingRow.paymentConfirmed),
        };
    }

    enrichBookingForAdmin(bookingInstance, timeZone, agentDeclineCount = 0) {
        const plain = bookingInstance.get
            ? bookingInstance.get({ plain: true })
            : bookingInstance;
        const tz = timeZone || BUSINESS_TIME_ZONE;
        const expired = isAgentAcceptExpired(plain, tz);
        return {
            ...plain,
            agentAcceptExpired: expired,
            agentDeclineCount,
            canAdminAssign: canAdminAssignOrReassignBooking(plain),
            agentBroadcastHeld: Boolean(plain.agentBroadcastHeld),
        };
    }

    /**
     * Cross-shop order history for a customer, regardless of zone — every shop
     * they have ever ordered from, with total + completed counts, ranked by
     * completed orders (real repeat business) then total.
     *
     * @param {number|null} excludeBookingId - optional; when set, that booking
     *   is omitted. Prefer null so totals match the customer's completed list.
     */
    async getCustomerShopHistory(customerId, excludeBookingId, options = {}) {
        if (!customerId) return [];
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
        try {
            const excludeClause =
                excludeBookingId != null && Number(excludeBookingId) > 0
                    ? "AND b.id != :excludeBookingId"
                    : "";
            const rows = await sequelize.query(
                `
                SELECT
                    a.id AS shopId,
                    bi.shopName AS shopName,
                    bi.id AS businessInfoId,
                    COUNT(*) AS totalOrders,
                    SUM(CASE WHEN b.bookingStatusId = :completedStatus THEN 1 ELSE 0 END) AS completedOrders,
                    SUM(COALESCE(bd.total, b.orderAmount, 0)) AS totalSpend,
                    SUM(
                        CASE
                            WHEN b.bookingStatusId = :completedStatus
                            THEN COALESCE(bd.total, b.orderAmount, 0)
                            ELSE 0
                        END
                    ) AS completedSpend
                FROM bookings b
                JOIN addressDbs a ON a.id = b.laundryShopId
                LEFT JOIN bussinessInformations bi ON bi.shopAddressId = a.id
                LEFT JOIN billingDetails bd ON bd.bookingId = b.id
                WHERE b.customerId = :customerId
                  AND b.laundryShopId IS NOT NULL
                  ${excludeClause}
                GROUP BY a.id, bi.shopName, bi.id
                ORDER BY completedOrders DESC, totalSpend DESC, totalOrders DESC
                LIMIT :limit
                `,
                {
                    replacements: {
                        customerId,
                        excludeBookingId: excludeBookingId || 0,
                        completedStatus: COMPLETED,
                        limit,
                    },
                    type: sequelize.QueryTypes.SELECT,
                }
            );
            return (Array.isArray(rows) ? rows : []).map((row) => {
                const completedOrders = Number(row.completedOrders) || 0;
                return {
                    shopId: Number(row.shopId),
                    businessInfoId:
                        row.businessInfoId != null
                            ? Number(row.businessInfoId)
                            : null,
                    shopName: row.shopName || `Shop #${row.shopId}`,
                    totalOrders: Number(row.totalOrders) || 0,
                    completedOrders,
                    totalSpend: Number(row.totalSpend) || 0,
                    completedSpend: Number(row.completedSpend) || 0,
                    isReturning:
                        completedOrders >= RETURNING_CUSTOMER_MIN_COMPLETED,
                };
            });
        } catch (err) {
            console.warn(
                `[getCustomerShopHistory] unavailable for customer ${customerId}:`,
                err?.message || err
            );
            return [];
        }
    }

    /**
     * Customers who have ordered at a shop (laundryShopId = addressDb id),
     * with completed counts, returning flag, and spend.
     * Ranked by completed orders then spend — same returning threshold as
     * getCustomerShopHistory.
     */
    async getShopCustomerHistory(shopAddressId, options = {}) {
        const shopId = Number(shopAddressId);
        if (!Number.isFinite(shopId) || shopId <= 0) return [];
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 200;
        try {
            const rows = await sequelize.query(
                `
                SELECT
                    u.id AS customerId,
                    u.firstName AS firstName,
                    u.lastName AS lastName,
                    u.email AS email,
                    u.phoneNum AS phoneNum,
                    u.countryCode AS countryCode,
                    COUNT(*) AS totalOrders,
                    SUM(CASE WHEN b.bookingStatusId = :completedStatus THEN 1 ELSE 0 END) AS completedOrders,
                    SUM(COALESCE(bd.total, b.orderAmount, 0)) AS totalSpend,
                    SUM(
                        CASE
                            WHEN b.bookingStatusId = :completedStatus
                            THEN COALESCE(bd.total, b.orderAmount, 0)
                            ELSE 0
                        END
                    ) AS completedSpend,
                    MAX(b.createdAt) AS lastOrderAt
                FROM bookings b
                JOIN users u ON u.id = b.customerId
                LEFT JOIN billingDetails bd ON bd.bookingId = b.id
                WHERE b.laundryShopId = :shopId
                  AND b.customerId IS NOT NULL
                GROUP BY u.id, u.firstName, u.lastName, u.email, u.phoneNum, u.countryCode
                ORDER BY completedOrders DESC, totalSpend DESC, totalOrders DESC
                LIMIT :limit
                `,
                {
                    replacements: {
                        shopId,
                        completedStatus: COMPLETED,
                        limit,
                    },
                    type: sequelize.QueryTypes.SELECT,
                }
            );
            return (Array.isArray(rows) ? rows : []).map((row) => {
                const completedOrders = Number(row.completedOrders) || 0;
                const first = String(row.firstName || "").trim();
                const last = String(row.lastName || "").trim();
                const name = [first, last].filter(Boolean).join(" ") || "Customer";
                return {
                    customerId: Number(row.customerId),
                    firstName: first || null,
                    lastName: last || null,
                    name,
                    email: row.email || null,
                    phoneNum: row.phoneNum || null,
                    countryCode: row.countryCode || null,
                    totalOrders: Number(row.totalOrders) || 0,
                    completedOrders,
                    totalSpend: Number(row.totalSpend) || 0,
                    completedSpend: Number(row.completedSpend) || 0,
                    lastOrderAt: row.lastOrderAt || null,
                    isReturning:
                        completedOrders >= RETURNING_CUSTOMER_MIN_COMPLETED,
                };
            });
        } catch (err) {
            console.warn(
                `[getShopCustomerHistory] unavailable for shop ${shopId}:`,
                err?.message || err
            );
            return [];
        }
    }

    /**
     * Enrich order list with assign flags.
     * Admin list UI only needs canAdminAssign — skip per-zone timezone + decline
     * queries (those were unused by the panel and added multi-hundred-ms latency).
     */
    async enrichBookingsForAdminList(bookingInstances) {
        return bookingInstances.map((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            return {
                ...plain,
                canAdminAssign: canAdminAssignOrReassignBooking(plain),
                agentBroadcastHeld: Boolean(plain.agentBroadcastHeld),
                agentAcceptExpired: false,
                agentDeclineCount: 0,
            };
        });
    }
}

module.exports = new AdminBookingAssignService();
