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
            shopList.push({
                laundryShopId: shop.id,
                userId: ownerId,
                zoneId: orderZoneId,
                zoneName,
                shopName: biz?.shopName || `Shop #${shop.id}`,
                isOpenNow: openNow,
                canAssign: !isCurrentShop,
                isCurrentShop,
                todayDayOfWeek,
                todayOpenTime: hoursRow?.openTime || null,
                todayCloseTime: hoursRow?.closeTime || null,
                todayScheduleActive: Boolean(hoursRow?.status),
            });
        }

        shopList.sort((a, b) =>
            String(a.shopName).localeCompare(String(b.shopName), undefined, {
                sensitivity: "base",
            })
        );

        const expired = isAgentAcceptExpired(bookingRow, countryCtx.ianaTimeZone);

        return {
            bookingId: bookingRow.id,
            orderTrackId: bookingRow.orderTrackId,
            invoiceStatus: bookingRow.invoiceStatus,
            zoneId: orderZoneId,
            zoneName,
            currentLaundryShopId: bookingRow.laundryShopId,
            adminAssignedShopId: bookingRow.adminAssignedShopId,
            agentAcceptExpired: expired,
            collectionDate: bookingRow.collectionDate,
            collectionTimeFrom: bookingRow.collectionTimeFrom,
            collectionTimeTo: bookingRow.collectionTimeTo,
            shopCount: shopList.length,
            shops: shopList,
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
