const {
    booking,
    addressDb,
    bussinessInformation,
    bookingHistory,
    proofOfDeliveries,
    zone,
    sequelize,
} = require("../../models");
const { ValidationError, NotFoundError, ConflictError } = require("../../middlewares/universalErrorHandler");
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
const {
    computeShopOrderDistances,
    sortAssignableShops,
} = require("../../utils/shopOrderDistanceRank");
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
                "deliveryDate",
                "deliveryTimeFrom",
                "deliveryTimeTo",
                "pickupAddresId",
            ],
            include: [
                {
                    model: zone,
                    attributes: ["id", "name"],
                    required: false,
                    paranoid: false,
                },
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: ["id", "lat", "lng"],
                    required: false,
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
            attributes: ["id", "userId", "zoneId", "status", "lat", "lng"],
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
            const historyRow = customerShopHistory.find(
                (h) => Number(h.shopId) === Number(shop.id)
            );
            // Straight-line km from the customer's pickup to this shop (null
            // when either side has no usable coordinates).
            const { pickupDistanceKm: distanceKm } =
                await computeShopOrderDistances(
                    shop.lat,
                    shop.lng,
                    bookingRow.pickupAddress,
                    null
                );
            // Room in this order's pickup / delivery slots (info for the admin;
            // a manual assign is allowed even when full).
            const { evaluateShopSlotCapacity } = require("../../utils/shopSlotCapacity");
            const slot = await evaluateShopSlotCapacity(
                ownerId,
                shop.id,
                bookingRow.get({ plain: true }),
                { excludeBookingId: bookingRow.id }
            ).catch(() => null);
            shopList.push({
                laundryShopId: shop.id,
                userId: ownerId,
                zoneId: orderZoneId,
                zoneName,
                distanceKm,
                slotCapacity: slot
                    ? {
                          hasRoom: slot.allowed,
                          mode: slot.mode,
                          limit: slot.limit,
                          slots: slot.slots,
                      }
                    : null,
                shopName: biz?.shopName || `Shop #${shop.id}`,
                isOpenNow: openNow,
                canAssign: !isCurrentShop,
                isCurrentShop,
                customerOrdersAtShop,
                customerTotalOrdersAtShop,
                isReturningCustomerAtShop:
                    customerOrdersAtShop >= RETURNING_CUSTOMER_MIN_COMPLETED,
                customerExcludedFromShop: Boolean(historyRow?.isExcluded),
                todayDayOfWeek,
                todayOpenTime: hoursRow?.openTime || null,
                todayCloseTime: hoursRow?.closeTime || null,
                todayScheduleActive: Boolean(hoursRow?.status),
            });
        }

        // Ordering: current shop pinned first, then NEAREST to the pickup,
        // then most completed orders for this customer, then name.
        sortAssignableShops(shopList);

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
            // False when the pickup address has no coordinates → no distances.
            pickupHasCoords: shopList.some((s) => s.distanceKm != null),
            shops: shopList,
            customerShopHistory,
        };
    }

    async assignBookingToShop(bookingId, laundryShopId, options = {}) {
        const actedByUserId = options.actedByUserId ?? null;
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

        const previousShopId =
            bookingRow.laundryShopId != null
                ? Number(bookingRow.laundryShopId)
                : null;

        const isReassign =
            bookingRow.laundryShopId != null &&
            Number(bookingRow.bookingStatusId) !== 1;

        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const timeStr = now.toTimeString().slice(0, 8);

        // Only if nobody changed the order since it was read (an agent accept
        // or another admin): otherwise the admin would silently overwrite it.
        const previousDeliveryDriverId = bookingRow.deliveryDriverId;
        const { Op } = require("sequelize");
        const [updated] = await booking.update(
            {
                laundryShopId: shop.id,
                bookingStatusId: 3,
                driverId: ownerId || null,
                // The new shop decides its delivery driver (auto-assign below).
                deliveryDriverId: null,
                adminAssignedShopId: null,
                agentBroadcastHeld: false,
                agentVisibleAt: null,
            },
            {
                where: {
                    id: bookingId,
                    bookingStatusId: bookingRow.bookingStatusId,
                    laundryShopId:
                        bookingRow.laundryShopId == null
                            ? { [Op.is]: null }
                            : bookingRow.laundryShopId,
                },
            }
        );
        if (!updated) {
            throw new ConflictError(
                "This order changed while you were assigning it (a shop just accepted it or it was moved). Refresh and try again."
            );
        }

        if (isReassign) {
            await proofOfDeliveries.destroy({ where: { bookingId } });
        }

        // The old shop's delivery driver no longer has this job.
        if (previousDeliveryDriverId != null && Number(previousDeliveryDriverId) !== Number(ownerId)) {
            try {
                const { notifyStaffAssignmentChange } = require("../../utils/staffAssignmentNotify");
                await notifyStaffAssignmentChange({
                    bookingId,
                    orderTrackId: bookingRow.orderTrackId,
                    assignmentType: "delivery",
                    action: "unassign",
                    fromUserId: previousDeliveryDriverId,
                    toUserId: null,
                    shopOwnerUserId: previousOwnerUserId,
                });
            } catch (notifyErr) {
                console.warn("[assignBookingToShop] delivery driver unassign notify skipped:", notifyErr?.message || notifyErr);
            }
        }

        try {
            const shopAssignmentAuditService = require("./shopAssignmentAuditService");
            await shopAssignmentAuditService.recordShopAssignment({
                bookingId,
                fromShopId: previousShopId,
                toShopId: shop.id,
                actedByUserId,
                source: "admin",
                note: previousShopId
                    ? "Admin reassigned shop"
                    : "Admin assigned shop",
            });
        } catch (auditErr) {
            console.warn(
                "[assignBookingToShop] shop audit skipped:",
                auditErr?.message || auditErr
            );
        }

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

        // Same as a shop accept: the new shop's default staff get the jobs.
        try {
            const autoAssignService = require("../Agent/autoAssignService");
            await autoAssignService.tryAutoAssignAfterAccept({
                shopAgentId: ownerId,
                bookingId: Number(bookingId),
                actedByUserId,
            });
        } catch (autoErr) {
            console.warn("[assignBookingToShop] auto-assign skipped:", autoErr?.message || autoErr);
        }

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
            const mapped = (Array.isArray(rows) ? rows : []).map((row) => {
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
                    isExcluded: false,
                    exclusionId: null,
                    exclusionReason: null,
                };
            });

            try {
                const customerShopExclusionService = require('./customerShopExclusionService');
                const exclusions =
                    await customerShopExclusionService.listForCustomer(customerId);
                const byShop = new Map(
                    exclusions.map((e) => [Number(e.shopAddressId), e])
                );
                for (const row of mapped) {
                    const ex = byShop.get(Number(row.shopId));
                    if (ex) {
                        row.isExcluded = true;
                        row.exclusionId = ex.id;
                        row.exclusionReason = ex.reason || null;
                    }
                }
                for (const ex of exclusions) {
                    const sid = Number(ex.shopAddressId);
                    if (mapped.some((m) => Number(m.shopId) === sid)) continue;
                    mapped.push({
                        shopId: sid,
                        businessInfoId: null,
                        shopName: ex.shopName || `Shop #${sid}`,
                        totalOrders: 0,
                        completedOrders: 0,
                        totalSpend: 0,
                        completedSpend: 0,
                        isReturning: false,
                        isExcluded: true,
                        exclusionId: ex.id,
                        exclusionReason: ex.reason || null,
                    });
                }
            } catch (exErr) {
                console.warn(
                    `[getCustomerShopHistory] exclusions skipped for customer ${customerId}:`,
                    exErr?.message || exErr
                );
            }

            try {
                const customerShopAssignmentService = require('./customerShopAssignmentService');
                const active =
                    await customerShopAssignmentService.getActiveAssignment(
                        customerId
                    );
                for (const row of mapped) {
                    row.isAssignedShop =
                        active != null &&
                        Number(active.shopAddressId) === Number(row.shopId);
                    row.activeAssignment = active || null;
                    row.assignedShopName = active?.shopName || null;
                }
                if (
                    active &&
                    !mapped.some(
                        (m) => Number(m.shopId) === Number(active.shopAddressId)
                    )
                ) {
                    mapped.unshift({
                        shopId: Number(active.shopAddressId),
                        businessInfoId: null,
                        shopName: active.shopName || `Shop #${active.shopAddressId}`,
                        totalOrders: 0,
                        completedOrders: 0,
                        totalSpend: 0,
                        completedSpend: 0,
                        isReturning: false,
                        isExcluded: false,
                        exclusionId: null,
                        exclusionReason: null,
                        isAssignedShop: true,
                        activeAssignment: active,
                        assignedShopName: active.shopName || null,
                    });
                }
            } catch (asErr) {
                console.warn(
                    `[getCustomerShopHistory] assignment skipped for customer ${customerId}:`,
                    asErr?.message || asErr
                );
            }

            return mapped;
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
