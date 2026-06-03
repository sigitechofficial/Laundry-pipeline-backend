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
const { sendEvent } = require("../../socket_io");
const { BUSINESS_TIME_ZONE } = require("../../utils/bookingTimeZone");

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
                "orderTrackId",
            ],
        });

        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        if (!canAdminAssignBooking(bookingRow)) {
            throw new ValidationError(
                "This order is not eligible for manual assign. It must be unassigned and past the agent accept window."
            );
        }

        const platformOpen = await isPlatformOpenNow(BUSINESS_TIME_ZONE);
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
            const openNow = await isShopOpenNow(ownerId, BUSINESS_TIME_ZONE);
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

        if (!canAdminAssignBooking(bookingRow)) {
            throw new ValidationError(
                "Order cannot be assigned: not expired or already assigned."
            );
        }

        if (!await isPlatformOpenNow(BUSINESS_TIME_ZONE)) {
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
        if (!(await isShopOpenNow(ownerId, BUSINESS_TIME_ZONE))) {
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
                bookingStatusId: 2,
                agentBroadcastHeld: false,
                agentVisibleAt: null,
            },
            { where: { id: bookingId } }
        );

        await bookingHistory.create({
            bookingId,
            bookingStatusId: 2,
            date: dateStr,
            time: timeStr,
        });

        const biz = await bussinessInformation.findOne({
            where: { shopAddressId: shop.id },
            attributes: ["shopName"],
        });

        if (ownerId) {
            sendEvent(ownerId, {
                type: "adminAssignedOrder",
                data: {
                    bookingId,
                    laundryShopId: shop.id,
                    message: "Order assigned to your shop by admin",
                },
            });
        }

        return {
            bookingId,
            laundryShopId: shop.id,
            bookingStatusId: 2,
            shopName: biz?.shopName || null,
        };
    }

    enrichBookingForAdmin(bookingInstance) {
        const plain = bookingInstance.get
            ? bookingInstance.get({ plain: true })
            : bookingInstance;
        const expired = isAgentAcceptExpired(plain);
        return {
            ...plain,
            agentAcceptExpired: expired,
            canAdminAssign: canAdminAssignBooking(plain),
            agentBroadcastHeld: Boolean(plain.agentBroadcastHeld),
        };
    }
}

module.exports = new AdminBookingAssignService();
