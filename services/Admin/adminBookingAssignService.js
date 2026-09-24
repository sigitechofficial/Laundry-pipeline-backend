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

        // Returning-customer signal per shop: how many COMPLETED orders (real
        // repeat business) and how many TOTAL orders (any status) this customer
        // has placed at each candidate shop, excluding this booking. Two grouped
        // queries up front — avoids an N+1 per-shop count in the loop.
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
                            id: { [Op.ne]: bookingRow.id },
                        },
                        group: ["laundryShopId"],
                    }),
                    booking.count({
                        where: {
                            customerId: bookingRow.customerId,
                            laundryShopId: { [Op.in]: shopIds },
                            id: { [Op.ne]: bookingRow.id },
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

        // Full cross-zone order history for this customer — surfaces shops
        // outside this booking's zone too, so the admin can see the customer's
        // whole track record, not just what's assignable in this zone.
        const customerShopHistory = await this.getCustomerShopHistory(
            bookingRow.customerId,
            bookingRow.id
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
     * completed orders (real repeat business) then total. Lets admin see a
     * customer's full track record even for shops outside the current booking's
     * zone/candidate list, not just the one shop currently being considered.
     */
    async getCustomerShopHistory(customerId, excludeBookingId, options = {}) {
        if (!customerId) return [];
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
        try {
            const rows = await sequelize.query(
                `
                SELECT
                    a.id AS shopId,
                    bi.shopName AS shopName,
                    COUNT(*) AS totalOrders,
                    SUM(CASE WHEN b.bookingStatusId = :completedStatus THEN 1 ELSE 0 END) AS completedOrders
                FROM bookings b
                JOIN addressDbs a ON a.id = b.laundryShopId
                LEFT JOIN bussinessInformations bi ON bi.shopAddressId = a.id
                WHERE b.customerId = :customerId
                  AND b.laundryShopId IS NOT NULL
                  AND b.id != :excludeBookingId
                GROUP BY a.id, bi.shopName
                ORDER BY completedOrders DESC, totalOrders DESC
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
                    shopName: row.shopName || `Shop #${row.shopId}`,
                    totalOrders: Number(row.totalOrders) || 0,
                    completedOrders,
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
