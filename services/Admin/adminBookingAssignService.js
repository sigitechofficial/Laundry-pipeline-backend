const {
    booking,
    addressDb,
    bussinessInformation,
    proofOfDeliveries,
} = require("../../models");
const { ValidationError, NotFoundError } = require("../../middlewares/universalErrorHandler");
const {
    isShopOpenNow,
    isPlatformOpenNow,
} = require("../../utils/shopWorkingHours");
const {
    canAdminAssignOrReassignBooking,
    isAgentAcceptExpired,
} = require("../../utils/bookingAgentWindow");
const {
    getCountryContextFromZoneId,
} = require("../../utils/countryTimeZone");
const {
    BUSINESS_TIME_ZONE,
    getOrderExpireTime,
} = require("../../utils/bookingTimeZone");
const agentBookingDeclineService = require("../Agent/agentBookingDeclineService");
const { notifyAdminBookingAssignment } = require("../../utils/bookingAdminAssignNotify");

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
                "orderTrackId",
                "customerId",
            ],
        });

        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        const countryCtx = await getCountryContextFromZoneId(bookingRow.zoneId);
        if (!canAdminAssignOrReassignBooking(bookingRow)) {
            throw new ValidationError(
                "This order cannot be assigned. Invoice may be finalized or the order is completed/cancelled."
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
            const isCurrentShop =
                bookingRow.laundryShopId != null &&
                Number(bookingRow.laundryShopId) === Number(shop.id);
            shopList.push({
                laundryShopId: shop.id,
                userId: ownerId,
                shopName: biz?.shopName || `Shop #${shop.id}`,
                isOpenNow: openNow,
                canAssign: openNow && !isCurrentShop,
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

        if (!canAdminAssignOrReassignBooking(bookingRow)) {
            throw new ValidationError(
                "Order cannot be assigned: invoice finalized or order completed/cancelled."
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

        if (
            bookingRow.laundryShopId != null &&
            Number(bookingRow.laundryShopId) === Number(shop.id) &&
            Number(bookingRow.bookingStatusId) !== 1
        ) {
            throw new ValidationError(
                "This order is already assigned to the selected shop."
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

        let previousOwnerUserId = null;
        if (bookingRow.laundryShopId) {
            const previousShop = await addressDb.findByPk(
                bookingRow.laundryShopId,
                { attributes: ["id", "userId"] }
            );
            previousOwnerUserId = previousShop?.userId || null;
        }

        const isReassign =
            bookingRow.laundryShopId != null &&
            Number(bookingRow.bookingStatusId) !== 1;

        await proofOfDeliveries.destroy({ where: { bookingId } });

        const visibleAt = new Date();

        await booking.update(
            {
                laundryShopId: null,
                adminAssignedShopId: shop.id,
                bookingStatusId: 1,
                driverId: null,
                agentBroadcastHeld: false,
                agentVisibleAt: visibleAt,
                orderExpireTime: getOrderExpireTime(assignCountryCtx.ianaTimeZone),
            },
            { where: { id: bookingId } }
        );

        const biz = await bussinessInformation.findOne({
            where: { shopAddressId: shop.id },
            attributes: ["shopName"],
        });

        await agentBookingDeclineService.clearDeclinesForBooking(bookingId);

        await notifyAdminBookingAssignment({
            bookingId,
            orderTrackId: bookingRow.orderTrackId,
            customerId: bookingRow.customerId,
            previousOwnerUserId,
            newOwnerUserId: ownerId,
            isReassign,
        });

        return {
            bookingId,
            laundryShopId: null,
            adminAssignedShopId: shop.id,
            bookingStatusId: 1,
            shopName: biz?.shopName || null,
            pendingAgentAccept: true,
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
