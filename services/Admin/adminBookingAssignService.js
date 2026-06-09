const {
    booking,
    addressDb,
    bussinessInformation,
    bookingHistory,
} = require("../../models");
const { ValidationError, NotFoundError } = require("../../middlewares/universalErrorHandler");
const {
    isShopOpenNow,
    isPlatformOpenNow,
} = require("../../utils/shopWorkingHours");
const {
    canAdminAssignBooking,
    isAgentAcceptExpired,
} = require("../../utils/bookingAgentWindow");
const { notifyBookingTakenByAgent } = require("../../utils/bookingTakenNotify");
const {
    getCountryContextFromZoneId,
} = require("../../utils/countryTimeZone");
const { BUSINESS_TIME_ZONE } = require("../../utils/bookingTimeZone");
const agentBookingDeclineService = require("../Agent/agentBookingDeclineService");

class AdminBookingAssignService {
    async getAssignableShops(bookingId) {
        const bookingRow = await booking.findByPk(bookingId, {
            attributes: [
                "id",
                "zoneId",
                "bookingStatusId",
                "laundryShopId",
                "agentBroadcastHeld",
                "agentVisibleAt",
                "createdAt",
                "orderExpireTime",
                "orderTrackId",
            ],
        });

        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        const countryCtx = await getCountryContextFromZoneId(bookingRow.zoneId);
        const hasAgentDecline = await agentBookingDeclineService.hasAnyDecline(bookingId);
        if (!canAdminAssignBooking(bookingRow, countryCtx.ianaTimeZone, { hasAgentDecline })) {
            throw new ValidationError(
                "This order is not eligible for manual assign. It must be unassigned and past the agent accept window or declined by an agent."
            );
        }

        const platformOpen = await isPlatformOpenNow(countryCtx.countryId);
        if (!platformOpen) {
            throw new ValidationError(
                "Platform is closed. Assign when platform operational hours are active."
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
            const openNow = await isShopOpenNow(
                ownerId,
                countryCtx.countryId
            );
            const biz = await bussinessInformation.findOne({
                where: { shopAddressId: shop.id },
                attributes: ["shopName"],
            });
            shopList.push({
                laundryShopId: shop.id,
                userId: ownerId,
                shopName: biz?.shopName || `Shop #${shop.id}`,
                isOpenNow: openNow,
                canAssign: openNow,
            });
        }

        return {
            bookingId: bookingRow.id,
            orderTrackId: bookingRow.orderTrackId,
            agentAcceptExpired: true,
            platformOpenNow: platformOpen,
            shops: shopList,
        };
    }

    async assignBookingToShop(bookingId, laundryShopId) {
        const bookingRow = await booking.findByPk(bookingId);
        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        const assignCountryCtx = await getCountryContextFromZoneId(
            bookingRow.zoneId
        );
        const hasAgentDecline = await agentBookingDeclineService.hasAnyDecline(bookingId);
        if (!canAdminAssignBooking(bookingRow, assignCountryCtx.ianaTimeZone, { hasAgentDecline })) {
            throw new ValidationError(
                "Order cannot be assigned: not expired, not declined by an agent, or already assigned."
            );
        }

        if (!await isPlatformOpenNow(assignCountryCtx.countryId)) {
            throw new ValidationError(
                "Platform is closed. Assign during platform operational hours."
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

        const ownerId = shop.userId;
        if (
            !(await isShopOpenNow(ownerId, assignCountryCtx.countryId))
        ) {
            throw new ValidationError(
                "Shop is closed right now. Assign only when the shop is open."
            );
        }

        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const timeStr = now.toTimeString().slice(0, 8);

        await booking.update(
            {
                laundryShopId: shop.id,
                bookingStatusId: 3,
                driverId: ownerId || null,
                agentBroadcastHeld: false,
                agentVisibleAt: null,
            },
            { where: { id: bookingId } }
        );

        await bookingHistory.bulkCreate(
            [2, 3].map((statusId) => ({
                bookingId,
                bookingStatusId: statusId,
                date: dateStr,
                time: timeStr,
            }))
        );

        const biz = await bussinessInformation.findOne({
            where: { shopAddressId: shop.id },
            attributes: ["shopName"],
        });

        await agentBookingDeclineService.clearDeclinesForBooking(bookingId);

        if (ownerId) {
            await notifyBookingTakenByAgent({
                bookingId,
                zoneId: bookingRow.zoneId,
                assignedUserId: ownerId,
                source: 'admin',
            });
        }

        return {
            bookingId,
            laundryShopId: shop.id,
            bookingStatusId: 3,
            shopName: biz?.shopName || null,
        };
    }

    enrichBookingForAdmin(bookingInstance, timeZone, agentDeclineCount = 0) {
        const plain = bookingInstance.get
            ? bookingInstance.get({ plain: true })
            : bookingInstance;
        const tz = timeZone || BUSINESS_TIME_ZONE;
        const expired = isAgentAcceptExpired(plain, tz);
        const hasAgentDecline = agentDeclineCount > 0;
        return {
            ...plain,
            agentAcceptExpired: expired,
            agentDeclineCount,
            canAdminAssign: canAdminAssignBooking(plain, tz, { hasAgentDecline }),
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
