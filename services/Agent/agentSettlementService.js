const { wallet, addressDb, users, bussinessInformation, sequelize } = require("../../models");
const { Op } = require("sequelize");
const {
    ValidationError,
    NotFoundError,
} = require("../../middlewares/universalErrorHandler");
const agentWalletService = require("./agentWalletService");
const { loadShopSettlementReport } = require("./shopSettlementReport");
const { emptySettlementReport } = require("../../utils/shopSettlementReportMap");
const agentWithdrawalService = require("./agentWithdrawalService");
const { buildAdminConnectPayoutLedger } = require("../../utils/adminPayoutLedger");
const { applyCashDueListQuery } = require("../../utils/adminListFilters");
const { sendNotification } = require("../../utils/notification");
const { sendEvent } = require("../../socket_io");

const {
    CASH_REMITTED_REFERENCE,
    ADMIN_SETTLEMENT_REFERENCE,
} = agentWalletService;

const DEFAULT_CURRENCY = "GBP";
const SHOP_ADDRESS_TYPE = "LaundaryShopAddress";

function parsePositiveId(value, label) {
    const id = parseInt(value, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError(`${label} must be a positive integer`);
    }
    return id;
}

async function resolveAgentShop(agentUserId) {
    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: SHOP_ADDRESS_TYPE,
        },
        attributes: ["id", "userId", "streetAddress", "district"],
    });
    if (!shop) {
        throw new NotFoundError("Agent shop address not found");
    }
    return shop;
}

const SHOP_ADDRESS_ATTRS = ["id", "userId", "streetAddress", "district"];

/**
 * Public admin identity is the shop (`bussinessInformation.id`, the same id
 * Shop Management uses in `/shop-management/details/:id`). Wallet still
 * settles on the owner user. Resolution order mirrors
 * shopManagementService.getSingleShopData / shopRevenueService.resolveShop:
 * business id → owner (agentId) → shop address id, then the legacy address
 * id so older settlement links keep working.
 */
async function resolveShopForSettlement(shopId) {
    const id = parsePositiveId(shopId, "shopId");

    const bizAttrs = ["id", "agentId", "shopAddressId"];
    let biz = await bussinessInformation.findOne({ where: { id }, attributes: bizAttrs });
    if (!biz) biz = await bussinessInformation.findOne({ where: { agentId: id }, attributes: bizAttrs });
    if (!biz) biz = await bussinessInformation.findOne({ where: { shopAddressId: id }, attributes: bizAttrs });

    let shop = null;
    if (biz) {
        if (biz.shopAddressId) {
            shop = await addressDb.findOne({
                where: { id: biz.shopAddressId, addressType: SHOP_ADDRESS_TYPE },
                attributes: SHOP_ADDRESS_ATTRS,
            });
        }
        if (!shop && biz.agentId) {
            shop = await addressDb.findOne({
                where: { userId: biz.agentId, addressType: SHOP_ADDRESS_TYPE },
                attributes: SHOP_ADDRESS_ATTRS,
            });
        }
    }
    if (!shop) {
        shop = await addressDb.findOne({
            where: { id, addressType: SHOP_ADDRESS_TYPE },
            attributes: SHOP_ADDRESS_ATTRS,
        });
    }
    if (!shop) {
        throw new NotFoundError("Shop not found");
    }

    const ownerUserId = shop.userId || biz?.agentId || null;
    if (!ownerUserId) {
        throw new NotFoundError("Shop has no owner account");
    }
    return {
        id: shop.id,
        userId: ownerUserId,
        streetAddress: shop.streetAddress,
        district: shop.district,
        businessId: biz?.id || null,
    };
}

/**
 * One money action per shop at a time. Locks the shop row (the same row agent
 * withdrawals lock), so the summary read after the lock already includes any
 * remittance / cash record / payout another request just wrote. Two clicks, two
 * admins or an app retry can no longer both pass the "amount ≤ due" check.
 */
async function withShopMoneyLock(agentUserId, work) {
    return sequelize.transaction(async (transaction) => {
        await addressDb.findOne({
            where: { userId: agentUserId, addressType: SHOP_ADDRESS_TYPE },
            attributes: ["id"],
            transaction,
            lock: transaction.LOCK.UPDATE,
        });
        return work(transaction);
    });
}

/** Same shop, same kind of entry, same amount within the last `seconds` (a retry or a double click). */
async function findRecentSameAmount(agentUserId, { referenceType, type, statuses, amount, seconds }, transaction) {
    return wallet.findOne({
        where: {
            userId: agentUserId,
            referenceType,
            type,
            status: { [Op.in]: statuses },
            amount: parseFloat(Number(amount).toFixed(2)),
            createdAt: { [Op.gte]: new Date(Date.now() - seconds * 1000) },
        },
        order: [["id", "DESC"]],
        transaction,
    });
}

/**
 * Zone managers only see and act on shops in their own zone (platform admins:
 * zoneId null = every shop). Unknown or other-zone shop → 404, like a missing id.
 */
async function assertAgentInZone(agentUserId, zoneId) {
    if (zoneId == null) return;
    const shop = await addressDb.findOne({
        where: { userId: agentUserId, addressType: SHOP_ADDRESS_TYPE },
        attributes: ["id", "zoneId"],
    });
    if (!shop || Number(shop.zoneId) !== Number(zoneId)) {
        throw new NotFoundError("Shop not found");
    }
}

async function assertShopInZone(shopId, zoneId) {
    if (zoneId == null) return;
    const shop = await resolveShopForSettlement(shopId);
    await assertAgentInZone(shop.userId, zoneId);
}

async function assertRemittanceInZone(remittanceId, zoneId) {
    if (zoneId == null) return;
    const entry = await wallet.findByPk(remittanceId, { attributes: ["id", "userId"] });
    if (!entry) throw new NotFoundError("Pending remittance not found");
    await assertAgentInZone(entry.userId, zoneId);
}

/** Owner user ids of the shops in a zone (null = no zone filter). */
async function ownerIdsInZone(zoneId) {
    if (zoneId == null) return null;
    const shops = await addressDb.findAll({
        where: { addressType: SHOP_ADDRESS_TYPE, zoneId: Number(zoneId), userId: { [Op.ne]: null } },
        attributes: ["userId"],
    });
    return shops.map((s) => Number(s.userId));
}

/** Split "Cash remittance (pending): note — completed: admin note" into its parts. */
function splitRemittanceNotes(plain) {
    const desc = String(plain.description || "");
    const base = desc.split(" — ")[0];
    const agentNote = base.includes("): ") ? base.slice(base.indexOf("): ") + 3).trim() : null;
    return {
        note: agentNote || null,
        adminNote: plain.adminNote || null,
        reviewedAt: plain.reviewedAt || null,
    };
}

/** Map owner userId → public shop id (business id; address id only if no business row). */
async function shopIdsByOwnerUserIds(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean).map((id) => Number(id)))];
    if (!ids.length) return new Map();
    const [shops, businesses] = await Promise.all([
        addressDb.findAll({
            where: {
                userId: { [Op.in]: ids },
                addressType: SHOP_ADDRESS_TYPE,
            },
            attributes: ["id", "userId"],
        }),
        bussinessInformation.findAll({
            where: { agentId: { [Op.in]: ids } },
            attributes: ["id", "agentId"],
        }),
    ]);
    const map = new Map(shops.map((shop) => [Number(shop.userId), shop.id]));
    for (const biz of businesses) {
        map.set(Number(biz.agentId), biz.id);
    }
    return map;
}

/**
 * Agent reports cash handed to admin (pending until admin confirms).
 */
async function submitCashRemittance(agentUserId, { amount, note }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    return withShopMoneyLock(agentUserId, async (transaction) => {
        // The app retries a POST whose answer was lost: the same amount again
        // within two minutes is that retry — answer with the first one.
        const recent = await findRecentSameAmount(agentUserId, {
            referenceType: CASH_REMITTED_REFERENCE,
            type: "credit",
            statuses: ["pending"],
            amount: parsedAmount,
            seconds: 120,
        }, transaction);
        const summary = await agentWalletService.getWalletSummary(agentUserId);
        if (recent) {
            return {
                remittanceId: recent.id,
                amount: parseFloat(recent.amount),
                status: recent.status,
                currency: recent.currency,
                cashDueToPlatform: summary.cashDueToPlatform,
                duplicate: true,
            };
        }

        const availableToRemit = parseFloat(
            (summary.cashDueToPlatform - summary.pendingCashRemittance).toFixed(2)
        );

        if (availableToRemit <= 0) {
            throw new ValidationError("No cash balance is available to remit");
        }

        if (parsedAmount > availableToRemit + 0.02) {
            throw new ValidationError(
                `Remittance amount exceeds available cash due (${availableToRemit.toFixed(2)})`
            );
        }

        const entry = await wallet.create({
            userId: agentUserId,
            bookingId: null,
            referenceType: CASH_REMITTED_REFERENCE,
            amount: parseFloat(parsedAmount.toFixed(2)),
            currency: summary.currency || DEFAULT_CURRENCY,
            type: "credit",
            status: "pending",
            description: note
                ? `Cash remittance (pending): ${note}`.slice(0, 255)
                : "Cash remittance submitted (pending admin confirmation)",
        }, { transaction });

        return {
            remittanceId: entry.id,
            amount: parseFloat(entry.amount),
            status: entry.status,
            currency: entry.currency,
            cashDueToPlatform: summary.cashDueToPlatform,
        };
    });
}

/**
 * The agent's OWN cash-remittance history, all statuses, newest first, so the
 * app can show pending / confirmed / rejected from the server instead of a
 * device-local list.
 */
async function listAgentRemittances(agentUserId, options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const { count, rows } = await wallet.findAndCountAll({
        where: {
            userId: agentUserId,
            referenceType: CASH_REMITTED_REFERENCE,
            type: "credit",
        },
        order: [["createdAt", "DESC"], ["id", "DESC"]],
        limit,
        offset,
    });

    const STATUS_LABEL = {
        pending: "Pending admin confirmation",
        completed: "Confirmed by admin",
        failed: "Rejected by admin",
    };

    const remittances = rows.map((row) => {
        const plain = row.get ? row.get({ plain: true }) : row;
        return {
            id: plain.id,
            amount: parseFloat(plain.amount || 0),
            currency: plain.currency || DEFAULT_CURRENCY,
            status: plain.status, // pending | completed | failed
            statusLabel: STATUS_LABEL[plain.status] || plain.status,
            description: plain.description || null,
            // Separate fields so the app never shows the admin's reason as the agent's own note.
            ...splitRemittanceNotes(plain),
            createdAt: plain.createdAt,
            updatedAt: plain.updatedAt,
        };
    });

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;
    return {
        remittances,
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}

async function listPendingRemittances(options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const where = {
        referenceType: CASH_REMITTED_REFERENCE,
        type: "credit",
        status: "pending",
    };
    if (options.agentUserId) {
        where.userId = options.agentUserId;
    }
    const zoneOwners = await ownerIdsInZone(options.zoneId);
    if (zoneOwners) {
        where.userId = options.agentUserId
            ? (zoneOwners.includes(Number(options.agentUserId)) ? options.agentUserId : -1)
            : { [Op.in]: zoneOwners.length ? zoneOwners : [-1] };
    }

    const { count, rows } = await wallet.findAndCountAll({
        where,
        order: [["createdAt", "ASC"]],
        limit,
        offset,
        include: [
            {
                model: users,
                as: "user",
                attributes: ["id", "firstName", "lastName", "email"],
                required: false,
            },
        ],
    });

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;
    const shopByOwner = await shopIdsByOwnerUserIds(rows.map((row) => row.userId));

    return {
        remittances: rows.map((row) => {
            const plain = row.get({ plain: true });
            return {
                id: plain.id,
                shopId: shopByOwner.get(Number(plain.userId)) || null,
                agentUserId: plain.userId,
                agentName: plain.user
                    ? `${plain.user.firstName || ""} ${plain.user.lastName || ""}`.trim()
                    : null,
                agentEmail: plain.user ? plain.user.email : null,
                amount: parseFloat(plain.amount || 0),
                currency: plain.currency,
                description: plain.description,
                ...splitRemittanceNotes(plain),
                status: plain.status,
                createdAt: plain.createdAt,
            };
        }),
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}

async function updateRemittanceStatus(remittanceId, status, adminNote, adminUserId = null) {
    const entry = await wallet.findOne({
        where: {
            id: remittanceId,
            referenceType: CASH_REMITTED_REFERENCE,
            type: "credit",
            status: "pending",
        },
    });

    if (!entry) {
        throw new NotFoundError("Pending remittance not found");
    }

    const description = adminNote
        ? `${entry.description} — ${status}: ${adminNote}`
        : `${entry.description} — ${status}`;

    // Only a still-pending row changes: two admins confirming at once → one wins.
    const [changed] = await wallet.update(
        {
            status,
            description: description.slice(0, 255),
            adminNote: adminNote ? String(adminNote).slice(0, 500) : null,
            reviewedByAdminId: adminUserId || null,
            reviewedAt: new Date(),
        },
        { where: { id: entry.id, status: "pending" } }
    );
    if (!changed) {
        throw new ValidationError("This remittance was already reviewed. Refresh the list.");
    }
    await entry.reload();

    const summary = await agentWalletService.getWalletSummary(entry.userId);

    // Notify the agent that admin confirmed/rejected their cash remittance, so
    // they know it landed (or was declined) without re-polling. Never fail the
    // status update because a notification failed.
    try {
        const amountLabel = `${summary.currency || 'GBP'} ${parseFloat(entry.amount || 0).toFixed(2)}`;
        const confirmed = status === 'completed';
        const title = confirmed ? 'Cash remittance confirmed' : 'Cash remittance rejected';
        const stillDue = `${summary.currency || 'GBP'} ${Number(summary.cashDueToPlatform || 0).toFixed(2)}`;
        const body = confirmed
            ? `Admin confirmed your ${amountLabel} cash payment. Cash still due: ${stillDue}.`
            : `Admin could not confirm your ${amountLabel} cash remittance${adminNote ? `: ${adminNote}` : ''}. It has been returned to pending cash due.`;
        const payload = {
            remittanceId: String(entry.id),
            type: 'CASH_REMITTANCE_UPDATE',
            status,
            amount: parseFloat(entry.amount || 0).toFixed(2),
            cashDueToPlatform: Number(summary.cashDueToPlatform || 0).toFixed(2),
        };
        sendNotification(entry.userId, title, body, payload).catch((e) =>
            console.error('[remittance] FCM notify failed:', e?.message || e)
        );
        sendEvent(entry.userId, { type: 'cashRemittanceUpdate', data: payload }).catch((e) =>
            console.error('[remittance] socket notify failed:', e?.message || e)
        );
    } catch (e) {
        console.error('[remittance] notify block failed:', e?.message || e);
    }

    const shopByOwner = await shopIdsByOwnerUserIds([entry.userId]);
    return {
        remittanceId: entry.id,
        shopId: shopByOwner.get(Number(entry.userId)) || null,
        agentUserId: entry.userId,
        amount: parseFloat(entry.amount || 0),
        status: entry.status,
        settlement: summary,
    };
}

async function confirmCashRemittance(remittanceId, adminNote, adminUserId) {
    return updateRemittanceStatus(remittanceId, "completed", adminNote, adminUserId);
}

async function rejectCashRemittance(remittanceId, adminNote, adminUserId) {
    return updateRemittanceStatus(remittanceId, "failed", adminNote, adminUserId);
}

/**
 * Admin directly records cash received from agent (no pending step).
 */
async function adminRecordCashSettlement(agentUserId, { amount, note, adminUserId }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    const entry = await withShopMoneyLock(agentUserId, async (transaction) => {
    const recent = await findRecentSameAmount(agentUserId, {
        referenceType: CASH_REMITTED_REFERENCE,
        type: "credit",
        statuses: ["completed"],
        amount: parsedAmount,
        seconds: 60,
    }, transaction);
    if (recent && String(recent.description || "").startsWith("Cash settlement recorded by admin")) {
        throw new ValidationError(
            "The same amount was recorded for this shop a moment ago. Refresh the page before recording it again."
        );
    }
    const summary = await agentWalletService.getWalletSummary(agentUserId);
    const availableToCollect = parseFloat(
        (summary.cashDueToPlatform - (summary.pendingCashRemittance || 0)).toFixed(2)
    );

    if (availableToCollect <= 0) {
        throw new ValidationError(
            summary.pendingCashRemittance > 0
                ? "The cash still due is already submitted by the shop and waiting in Pending remittances — confirm it there instead."
                : "No cash is currently due from this agent"
        );
    }

    if (parsedAmount > availableToCollect + 0.02) {
        throw new ValidationError(
            `Amount exceeds cash still due (${availableToCollect.toFixed(2)})`
        );
    }

    const adminSuffix = adminUserId ? ` (admin #${adminUserId})` : "";
    return wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: CASH_REMITTED_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: "credit",
        status: "completed",
        description: note
            ? `Cash settlement recorded by admin${adminSuffix}: ${note}`.slice(0, 255)
            : `Cash settlement recorded by admin${adminSuffix}`,
        reviewedByAdminId: adminUserId || null,
        reviewedAt: new Date(),
        adminNote: note ? String(note).slice(0, 500) : null,
    }, { transaction });
    });

    const updatedSummary = await agentWalletService.getWalletSummary(agentUserId);

    return {
        settlementId: entry.id,
        amount: parseFloat(entry.amount),
        settlement: updatedSummary,
    };
}

/**
 * Admin manual adjustment (e.g. correction, bonus, penalty).
 */
async function adminRecordAdjustment(agentUserId, { amount, direction, note, adminUserId }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    if (!String(note || "").trim()) {
        throw new ValidationError("A reason is required for a settlement adjustment");
    }
    const normalizedDirection = String(direction || "credit").toLowerCase();
    if (normalizedDirection !== "credit" && normalizedDirection !== "debit") {
        throw new ValidationError("direction must be 'credit' or 'debit'");
    }

    await resolveAgentShop(agentUserId);
    const summary = await agentWalletService.getWalletSummary(agentUserId);

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: ADMIN_SETTLEMENT_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: normalizedDirection,
        status: "completed",
        description: `Admin settlement adjustment${adminUserId ? ` (admin #${adminUserId})` : ""}: ${String(note || "").trim()}`.slice(0, 255),
        reviewedByAdminId: adminUserId || null,
        reviewedAt: new Date(),
        adminNote: String(note || "").trim().slice(0, 500) || null,
    });

    const updatedSummary = await agentWalletService.getWalletSummary(agentUserId);

    return {
        adjustmentId: entry.id,
        amount: parseFloat(entry.amount),
        type: entry.type,
        settlement: updatedSummary,
    };
}

/**
 * Admin pays the agent's card earnings into their Stripe Connect account.
 * Ledger: completed credit (reduces still-owed) + completed withdrawal debit
 * (so the same money cannot be withdrawn again).
 */
async function recordAgentPayout(agentUserId, { amount, note, adminUserId }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    // Check + reserve under the shop lock: a second click / second admin waits,
    // then sees this payout as in-flight and cannot send the same money again.
    const { credit, currency } = await withShopMoneyLock(agentUserId, async (transaction) => {
        const recent = await findRecentSameAmount(agentUserId, {
            referenceType: "agent_payout",
            type: "credit",
            statuses: ["pending", "completed"],
            amount: parsedAmount,
            seconds: 60,
        }, transaction);
        if (recent) {
            throw new ValidationError(
                "A payout of this amount was just sent to this shop. Refresh the page before sending another."
            );
        }
        const summary = await agentWalletService.getWalletSummary(agentUserId);

        if (summary.platformOwesAgent <= 0) {
            throw new ValidationError("No earnings available to pay out to this agent");
        }

        if (parsedAmount > summary.platformOwesAgent + 0.02) {
            throw new ValidationError(
                `Payout exceeds payable balance (${summary.platformOwesAgent.toFixed(2)})`
            );
        }

        const currencyCode = summary.currency || DEFAULT_CURRENCY;
        const pendingPair = buildAdminConnectPayoutLedger({
            userId: agentUserId,
            amount: parsedAmount,
            currency: currencyCode,
            note,
            adminUserId,
            stripeTransferId: null,
        });
        const row = await wallet.create({
            ...pendingPair.credit,
            status: "pending",
        }, { transaction });
        return { credit: row, currency: currencyCode };
    });

    let transfer;
    try {
        ({ transfer } = await agentWithdrawalService.transferToAgentConnectAccount(
            agentUserId,
            parsedAmount,
            `agent-admin-payout-${credit.id}`,
            {
                adminUserId: adminUserId || null,
                walletId: credit.id,
                note: note || null,
                transferKind: "admin_payout",
                withdrawalType: "admin_payout",
            }
        ));
    } catch (error) {
        const reason = String(error?.message || error).slice(0, 500);
        // The Stripe transfer did not go through — this pending credit must
        // reach "failed" no matter what, or it silently keeps depressing
        // platformOwesAgent (pendingAgentPayouts) forever, making "Still
        // Payable" look like the agent was already paid when they weren't.
        try {
            await credit.update({
                status: "failed",
                failureReason: reason,
            });
        } catch (updateError) {
            // If the ORM write itself fails (e.g. schema drift on a column
            // this app expects), fall back to the smallest possible raw
            // write so the row still reaches a terminal status. Log loudly —
            // this is a wallet-ledger inconsistency, not a normal 4xx.
            console.error(
                `[recordAgentPayout] CRITICAL: could not mark wallet credit ${credit.id} as failed ` +
                    `after a Stripe transfer error (agentUserId=${agentUserId}, amount=${parsedAmount}). ` +
                    `Row is stuck "pending" and will distort platformOwesAgent until fixed. ` +
                    `Transfer error: ${reason} | Update error: ${updateError?.message || updateError}`
            );
            try {
                await sequelize.query(
                    "UPDATE wallets SET status = :status WHERE id = :id",
                    { replacements: { status: "failed", id: credit.id } }
                );
            } catch (fallbackError) {
                console.error(
                    `[recordAgentPayout] CRITICAL: raw-SQL fallback also failed for wallet credit ${credit.id}. ` +
                        `Manual reconciliation required. ${fallbackError?.message || fallbackError}`
                );
            }
        }
        throw error;
    }

    const completedPair = buildAdminConnectPayoutLedger({
        userId: agentUserId,
        amount: parsedAmount,
        currency,
        note,
        adminUserId,
        stripeTransferId: transfer.id,
    });

    let debit;
    try {
        debit = await sequelize.transaction(async (transaction) => {
            await credit.update(
                {
                    status: "completed",
                    stripeTransferId: transfer.id,
                    description: completedPair.credit.description,
                    failureReason: null,
                },
                { transaction }
            );
            return wallet.create(completedPair.debit, { transaction });
        });
    } catch (error) {
        // Stripe transfer `transfer.id` has ALREADY succeeded — real money moved.
        // The only thing that failed is recording it. Leaving the credit
        // "pending" here is the worst outcome: it counts as in-flight against
        // "Still Payable", hides the money from every balance, and invites a
        // retry that sends the same earnings again. Land the two facts needed
        // to reconcile (completed + transfer id) with a minimal raw write.
        console.error(
            `[recordAgentPayout] CRITICAL: Stripe transfer ${transfer.id} succeeded but wallet credit ${credit.id} ` +
                `could not be completed (agentUserId=${agentUserId}, amount=${parsedAmount}). ` +
                `Attempting raw-SQL fallback. ${error?.message || error}`
        );
        try {
            await sequelize.query(
                "UPDATE wallets SET status = :status, stripeTransferId = :stripeTransferId WHERE id = :id",
                {
                    replacements: {
                        status: "completed",
                        stripeTransferId: transfer.id,
                        id: credit.id,
                    },
                }
            );
        } catch (fallbackError) {
            console.error(
                `[recordAgentPayout] CRITICAL: raw-SQL fallback also failed for wallet credit ${credit.id} ` +
                    `(Stripe transfer ${transfer.id} already succeeded — money moved, ledger does not reflect it). ` +
                    `Manual reconciliation required. ${fallbackError?.message || fallbackError}`
            );
            throw error;
        }
        // The paired debit keeps the released amount out of the agent's
        // withdrawable balance. Without it the wallet would offer these same
        // earnings for withdrawal again, so treat its absence as an error too.
        try {
            debit = await wallet.create(completedPair.debit);
        } catch (debitError) {
            console.error(
                `[recordAgentPayout] CRITICAL: credit ${credit.id} recorded as completed for Stripe transfer ${transfer.id}, ` +
                    `but the paired withdrawal debit could not be created — the agent wallet will show this amount as ` +
                    `withdrawable until reconciled. ${debitError?.message || debitError}`
            );
            throw error;
        }
    }

    const updatedSummary = await agentWalletService.getWalletSummary(agentUserId);

    return {
        payoutId: credit.id,
        withdrawalId: debit.id,
        stripeTransferId: transfer.id,
        amount: parseFloat(credit.amount),
        destination: "stripe_connect",
        settlement: updatedSummary,
    };
}

async function getAgentSettlementSummary(agentUserId) {
    await resolveAgentShop(agentUserId);
    return agentWalletService.getWalletSummary(agentUserId);
}

async function getShopSettlementSummary(shopId) {
    const shop = await resolveShopForSettlement(shopId);
    return getAgentSettlementSummary(shop.userId);
}

async function getShopSettlementDetail(shopId, options = {}) {
    const shop = await resolveShopForSettlement(shopId);
    return getAgentSettlementDetail(shop.userId, options);
}

async function adminRecordShopCashSettlement(shopId, payload) {
    const shop = await resolveShopForSettlement(shopId);
    return adminRecordCashSettlement(shop.userId, payload);
}

async function adminRecordShopAdjustment(shopId, payload) {
    const shop = await resolveShopForSettlement(shopId);
    return adminRecordAdjustment(shop.userId, payload);
}

async function recordShopPayout(shopId, payload) {
    const shop = await resolveShopForSettlement(shopId);
    return recordAgentPayout(shop.userId, payload);
}

/**
 * Full enterprise-grade settlement detail for one agent: identity, aggregate
 * summary, the complete wallet ledger (every credit/debit that fed the
 * summary numbers), and the per-order breakdown of what was collected/earned
 * on each completed order. Powers the admin "view" detail page so nothing is
 * hidden behind a single modal with just the totals.
 */
async function getAgentSettlementDetail(agentUserId, options = {}) {
    const shop = await resolveAgentShop(agentUserId);

    const emptyPage = { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false };

    const [agentUser, businessInfo, summary, ledger, orders, recentActivity, earningsReport, remittanceHistory] = await Promise.all([
        users.findByPk(agentUserId, {
            attributes: ["id", "firstName", "lastName", "email", "phoneNum", "status", "createdAt"],
        }),
        bussinessInformation.findOne({
            where: { shopAddressId: shop.id },
            attributes: ["id", "shopName", "connectAccountId", "isConnectAccountConnected"],
        }),
        agentWalletService.getWalletSummary(agentUserId),
        agentWalletService.listAdminSettlementLedger(agentUserId, {
            page: options.ledgerPage,
            limit: options.ledgerLimit,
            rail: options.ledgerRail,
            referenceType: options.ledgerType,
        }).catch((err) => {
            console.warn(`[settlement-detail] ledger skipped for ${agentUserId}:`, err.message);
            return { transactions: [], pagination: emptyPage, statement: null };
        }),
        agentWalletService.listAgentOrderBreakdown(agentUserId, {
            page: options.ordersPage,
            limit: options.ordersLimit,
        }).catch((err) => {
            console.warn(`[settlement-detail] orders skipped for ${agentUserId}:`, err.message);
            return { orders: [], pagination: emptyPage };
        }),
        agentWalletService.listRecentSettlementActivity(agentUserId, 12).catch((err) => {
            console.warn(`[settlement-detail] activity skipped for ${agentUserId}:`, err.message);
            return [];
        }),
        loadShopSettlementReport(shop.id).catch((err) => {
            console.warn(`[settlement-detail] earnings report skipped for shop ${shop.id}:`, err.message);
            return { ...emptySettlementReport(), loadError: err.message };
        }),
        listAgentRemittances(agentUserId, { page: 1, limit: 50 }).catch((err) => {
            console.warn(`[settlement-detail] remittances skipped for ${agentUserId}:`, err.message);
            return { remittances: [], pagination: emptyPage };
        }),
    ]);

    return {
        identity: {
            shopId: businessInfo?.id || shop.id,
            shopAddressId: shop.id,
            ownerUserId: agentUser?.id || agentUserId,
        },
        agent: {
            id: agentUser?.id || agentUserId,
            name: agentUser
                ? `${agentUser.firstName || ""} ${agentUser.lastName || ""}`.trim()
                : null,
            email: agentUser?.email || null,
            phone: agentUser?.phoneNum || null,
            status: agentUser?.status,
            joinedAt: agentUser?.createdAt || null,
        },
        shop: {
            id: shop.id,
            name: businessInfo?.shopName || null,
            address: shop.streetAddress || null,
            district: shop.district || null,
            connectAccountConnected: Boolean(
                businessInfo?.connectAccountId && businessInfo?.isConnectAccountConnected
            ),
        },
        summary,
        ledger: ledger.transactions,
        ledgerPagination: ledger.pagination,
        statement: ledger.statement || null,
        orders: orders.orders,
        ordersPagination: orders.pagination,
        earningsReport,
        remittances: remittanceHistory.remittances || [],
        recentActivity,
        formulas: {
            cashDue:
                "Ledger cash due = cash collected − cash refunded − commission credited (cash + card, net of clawbacks) − cash remitted ± admin adjustments. Recording cash raises remitted and can make live due £0 — remitted history stays.",
            cashInTill:
                "Physical cash still with the agent before commission netting = collected − refunded − remitted.",
            payable:
                "Still payable = card commission + extra tips − extra-tip clawbacks − payouts already sent to Stripe Connect (including in-flight admin payouts).",
            withdrawn:
                "Admin payout sends money to the agent's Stripe Connect account immediately. Agent withdraw requests also go to Connect after admin approval. Completed Connect transfers cannot be paid twice.",
            statement:
                "Bank-statement view: Money in / Money out per row, with settlement balance before & after. Negative settlement balance = cash due to platform. Wallet balance tracks payouts minus withdrawals.",
            cashPaymentFlow:
                "Cash COD: invoice → proceed unpaid → deliver → recordCashPayment → cash_collected + commission → agent remits / admin records cash received.",
            adminTake:
                "Admin / platform take on paid orders = service fee + zone commission. Service fee is never shop income. Amounts are net of customer refunds.",
            payMix:
                "Card vs cash is the collection channel, not the original booking toggle. Mixed = booked on card, remaining balance collected in cash. Unique customers can appear in both columns if they used both methods.",
        },
    };
}

/**
 * Shops/agents with settlement activity, for the admin cash-due tab.
 *
 * Shared list contract (utils/listQuery, applied in memory after the wallet
 * summaries are built): search (shop name, owner name, email, phone, address),
 * sortBy (cashDueToPlatform default | shopName | agentName) / sortDir,
 * page / limit (default 20), export=1 → whole filtered set (capped).
 */
async function listAgentsWithCashDue(options = {}) {
    try {
        await agentWalletService.backfillMissingCashLedger({ limit: 200 });
    } catch (err) {
        console.warn(
            "[cash-due] wallet self-heal failed:",
            err.message
        );
    }

    const shops = await addressDb.findAll({
        where: {
            addressType: "LaundaryShopAddress",
            userId: { [Op.ne]: null },
            ...(options.zoneId != null ? { zoneId: Number(options.zoneId) } : {}),
        },
        attributes: ["id", "userId", "streetAddress", "district"],
        include: [
            {
                model: users,
                attributes: ["id", "firstName", "lastName", "email", "phoneNum", "countryCode"],
                required: false,
            },
            {
                model: bussinessInformation,
                attributes: ["id", "shopName"],
                required: false,
            },
        ],
    });

    const summaries = [];
    for (const shop of shops) {
        if (!shop.userId) continue;
        try {
            const summary = await agentWalletService.getWalletSummary(shop.userId);
            if (agentWalletService.hasSettlementActivity(summary)) {
                const businessRows = shop.bussinessInformations || shop.bussinessInformation;
                const businessRow = Array.isArray(businessRows) ? businessRows[0] : businessRows;
                const shopName = businessRow?.shopName;
                summaries.push({
                    agentUserId: shop.userId,
                    shopId: businessRow?.id || shop.id,
                    shopAddressId: shop.id,
                    shopName: shopName || null,
                    shopAddress: shop.streetAddress,
                    agentName: shop.user
                        ? `${shop.user.firstName || ""} ${shop.user.lastName || ""}`.trim()
                        : null,
                    agentEmail: shop.user?.email || null,
                    agentPhone: shop.user?.phoneNum || null,
                    agentCountryCode: shop.user?.countryCode || null,
                    ...summary,
                });
            }
        } catch (err) {
            console.warn(
                `[cash-due] skipped shop ${shop.id} user ${shop.userId}:`,
                err.message
            );
        }
    }

    summaries.sort((a, b) => b.cashDueToPlatform - a.cashDueToPlatform);
    const listed = applyCashDueListQuery(summaries, options);

    // Totals over the WHOLE filtered set (search applied), independent of the
    // page window, so the admin summary cards never reflect just one page.
    const matched = applyCashDueListQuery(summaries, { ...options, export: '1', page: undefined, limit: undefined }).rows;
    const sum = (key) =>
        Math.round(matched.reduce((acc, row) => acc + (Number(row[key]) || 0), 0) * 100) / 100;
    const summary = {
        shops: matched.length,
        totalCashDue: sum('cashDueToPlatform'),
        totalPending: sum('pendingCashRemittance'),
        totalPayable: sum('platformOwesAgent'),
        totalRemitted: sum('totalCashRemitted'),
        totalReleased: sum('totalAgentPayouts'),
        totalCollected: sum('totalCashCollected'),
    };

    return {
        agents: listed.rows,
        summary,
        pagination: {
            // legacy keys
            page: listed.pagination.currentPage,
            limit: listed.pagination.recordsPerPage,
            total: listed.pagination.totalRecords,
            // standard list contract (utils/listQuery)
            ...listed.pagination,
        },
        search: listed.search,
    };
}

async function syncAgentWalletsFromBookings(options = {}) {
    return agentWalletService.backfillWalletsFromPaidBookings(options);
}

module.exports = {
    submitCashRemittance,
    listAgentRemittances,
    listPendingRemittances,
    confirmCashRemittance,
    rejectCashRemittance,
    adminRecordCashSettlement,
    adminRecordAdjustment,
    recordAgentPayout,
    getAgentSettlementSummary,
    getAgentSettlementDetail,
    getShopSettlementSummary,
    getShopSettlementDetail,
    adminRecordShopCashSettlement,
    adminRecordShopAdjustment,
    recordShopPayout,
    listAgentsWithCashDue,
    syncAgentWalletsFromBookings,
    resolveShopForSettlement,
    assertAgentInZone,
    assertShopInZone,
    assertRemittanceInZone,
};
