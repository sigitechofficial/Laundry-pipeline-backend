const {
    booking,
    addressDb,
    bussinessInformation,
    bookingHistory,
    proofOfDeliveries,
} = require("../../models");
const { ValidationError, NotFoundError } = require("../../middlewares/universalErrorHandler");
const {
    isShopScheduleOpenNow,
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
            ],
        });

        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        const countryCtx = await getCountryContextFromZoneId(bookingRow.zoneId);
        const assignBlockedReason = getAdminAssignBlockedReason(bookingRow);
        if (assignBlockedReason) {
            throw new ValidationError(
                `This order cannot be assigned. ${assignBlockedReason}`
            );
        }

        const shops = await addressDb.findAll({
            where: {
                zoneId: bookingRow.zoneId,
                addressType: "LaundaryShopAddress",
            },
            attributes: ["id", "userId", "zoneId"],
        });

        const shopList = [];
        for (const shop of shops) {
            const ownerId = shop.userId;
            const openNow = await isShopScheduleOpenNow(
                ownerId,
                countryCtx.countryId
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
                shopName: biz?.shopName || `Shop #${shop.id}`,
                isOpenNow: openNow,
                canAssign: !isCurrentShop,
                isCurrentShop,
            });
        }

        const expired = isAgentAcceptExpired(bookingRow, countryCtx.ianaTimeZone);

        return {
            bookingId: bookingRow.id,
            orderTrackId: bookingRow.orderTrackId,
            invoiceStatus: bookingRow.invoiceStatus,
            currentLaundryShopId: bookingRow.laundryShopId,
            adminAssignedShopId: bookingRow.adminAssignedShopId,
            agentAcceptExpired: expired,
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

        const shop = await addressDb.findOne({
            where: {
                id: laundryShopId,
                addressType: "LaundaryShopAddress",
                zoneId: bookingRow.zoneId,
            },
            attributes: ["id", "userId", "zoneId"],
        });

        if (!shop) {
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
     * Enrich order list with assign flags using each booking zone's country timezone.
     */
    async enrichBookingsForAdminList(bookingInstances) {
        const zoneIds = [
            ...new Set(
                bookingInstances
                    .map((row) => {
                        const plain = row.get ? row.get({ plain: true }) : row;
                        return plain.zoneId;
                    })
                    .filter(Boolean)
            ),
        ];

        const tzByZone = new Map();
        await Promise.all(
            zoneIds.map(async (zoneId) => {
                const ctx = await getCountryContextFromZoneId(zoneId);
                tzByZone.set(zoneId, ctx.ianaTimeZone);
            })
        );

        const bookingIds = bookingInstances.map((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            return plain.id;
        });
        const declineCountByBooking =
            await agentBookingDeclineService.getDeclineCountByBookingIds(bookingIds);

        return bookingInstances.map((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            const tz =
                tzByZone.get(plain.zoneId) || BUSINESS_TIME_ZONE;
            const declineCount = declineCountByBooking.get(plain.id) || 0;
            return this.enrichBookingForAdmin(plain, tz, declineCount);
        });
    }
}

module.exports = new AdminBookingAssignService();
