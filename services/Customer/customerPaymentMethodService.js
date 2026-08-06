"use strict";

const { Op } = require("sequelize");
const { users, booking } = require("../../models");
const {
    ValidationError,
    NotFoundError,
} = require("../../middlewares/universalErrorHandler");
const {
    createStripeCustomer,
    createSetupIntent,
    attachPaymentMethodToCustomer,
    listCustomerCardPaymentMethods,
    retrievePaymentMethod,
    detachPaymentMethod,
    setStripeCustomerDefaultPaymentMethod,
} = require("../../controllers/stripe");

/** Terminal booking statuses — do not sync payment method onto these. */
const TERMINAL_BOOKING_STATUS_IDS = [17, 19, 20]; // Completed, Cancelled, Refunded

function isCardExpired(expMonth, expYear) {
    const month = Number(expMonth);
    const year = Number(expYear);
    if (!Number.isFinite(month) || !Number.isFinite(year)) return false;
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    if (year < currentYear) return true;
    if (year === currentYear && month < currentMonth) return true;
    return false;
}

function mapPaymentMethodCard(pm, defaultPaymentMethodId) {
    const card = pm.card || {};
    const expMonth = card.exp_month ?? null;
    const expYear = card.exp_year ?? null;
    return {
        paymentMethodId: pm.id,
        brand: card.brand || null,
        last4: card.last4 || null,
        expMonth,
        expYear,
        isDefault: pm.id === defaultPaymentMethodId,
        isExpired: isCardExpired(expMonth, expYear),
    };
}

class CustomerPaymentMethodService {
    async _getCustomerUser(userId) {
        try {
            const user = await users.findOne({
                where: { id: userId, deletedAt: null },
                attributes: [
                    "id",
                    "firstName",
                    "lastName",
                    "email",
                    "stripeCustomerId",
                    "defaultPaymentMethodId",
                    "cardBrand",
                    "cardLast4",
                    "cardExpMonth",
                    "cardExpYear",
                    "cardUpdatedAt",
                ],
            });
            if (!user) {
                throw new NotFoundError("Customer not found");
            }
            return user;
        } catch (err) {
            console.error(
                `[paymentMethods] _getCustomerUser failed userId=${userId}:`,
                err?.parent?.sqlMessage || err?.message || err
            );
            throw err;
        }
    }

    async _ensureStripeCustomer(user) {
        if (user.stripeCustomerId) {
            return user.stripeCustomerId;
        }
        const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
        const stripeCustomerId = await createStripeCustomer(name, user.email);
        await user.update({ stripeCustomerId });
        return stripeCustomerId;
    }

    async _assertPaymentMethodOwnedByCustomer(paymentMethodId, stripeCustomerId) {
        const pm = await retrievePaymentMethod(paymentMethodId);
        if (!pm || pm.object !== "payment_method") {
            throw new ValidationError("Invalid payment method");
        }
        if (pm.customer && pm.customer !== stripeCustomerId) {
            throw new ValidationError("Payment method does not belong to this customer");
        }
        return pm;
    }

    /**
     * Sync active card onto open card bookings so invoice/balance charges use it.
     */
    async syncOpenBookingsPaymentMethod(customerUserId, paymentMethodId) {
        const [updated] = await booking.update(
            { paymentMethodId },
            {
                where: {
                    customerId: customerUserId,
                    paymentType: "card",
                    bookingStatusId: { [Op.notIn]: TERMINAL_BOOKING_STATUS_IDS },
                    [Op.or]: [
                        { paymentMethodId: { [Op.ne]: paymentMethodId } },
                        { paymentMethodId: null },
                    ],
                },
            }
        );
        return updated;
    }

    async _persistDefaultCard(user, paymentMethod) {
        const card = paymentMethod.card || {};
        await user.update({
            defaultPaymentMethodId: paymentMethod.id,
            cardBrand: card.brand || null,
            cardLast4: card.last4 || null,
            cardExpMonth: card.exp_month ?? null,
            cardExpYear: card.exp_year ?? null,
            cardUpdatedAt: new Date(),
        });
        if (user.stripeCustomerId) {
            try {
                await setStripeCustomerDefaultPaymentMethod(
                    user.stripeCustomerId,
                    paymentMethod.id
                );
            } catch (err) {
                console.warn(
                    "[paymentMethods] Stripe default PM update failed:",
                    err.message
                );
            }
        }
    }

    /**
     * GET — list all cards; one marked isDefault.
     */
    async listPaymentMethods(userId) {
        const user = await this._getCustomerUser(userId);
        if (!user.stripeCustomerId) {
            return {
                defaultPaymentMethodId: null,
                cards: [],
            };
        }

        const methods = await listCustomerCardPaymentMethods(user.stripeCustomerId);
        let defaultId = user.defaultPaymentMethodId;

        // If cached default is missing from Stripe, clear / pick first
        if (defaultId && !methods.some((m) => m.id === defaultId)) {
            defaultId = methods[0]?.id || null;
            if (defaultId) {
                await this._persistDefaultCard(user, methods[0]);
            } else {
                await user.update({
                    defaultPaymentMethodId: null,
                    cardBrand: null,
                    cardLast4: null,
                    cardExpMonth: null,
                    cardExpYear: null,
                    cardUpdatedAt: new Date(),
                });
            }
        }

        // If user has cards but no default yet, set first as default (legacy data)
        if (!defaultId && methods.length > 0) {
            defaultId = methods[0].id;
            await this._persistDefaultCard(user, methods[0]);
            await this.syncOpenBookingsPaymentMethod(userId, defaultId);
        }

        return {
            defaultPaymentMethodId: defaultId,
            cardBrand: user.cardBrand,
            cardLast4: user.cardLast4,
            cards: methods.map((pm) => mapPaymentMethodCard(pm, defaultId)),
        };
    }

    /**
     * Create SetupIntent for adding a new card (no charge).
     */
    async createSetupIntentForCustomer(userId) {
        const user = await this._getCustomerUser(userId);
        const stripeCustomerId = await this._ensureStripeCustomer(user);
        const setupIntent = await createSetupIntent(stripeCustomerId);

        return {
            setupIntentId: setupIntent.id,
            clientSecret: setupIntent.client_secret,
            stripeCustomerId,
            status: setupIntent.status,
            isSetupIntent: true,
        };
    }

    /**
     * Option A: attach (if needed) + set as active default + sync open bookings.
     * Used right after SetupIntent confirm for a newly added card.
     */
    async addAndActivatePaymentMethod(userId, paymentMethodId) {
        if (!paymentMethodId || typeof paymentMethodId !== "string") {
            throw new ValidationError("paymentMethodId is required");
        }

        const user = await this._getCustomerUser(userId);
        const stripeCustomerId = await this._ensureStripeCustomer(user);

        let pm = await this._assertPaymentMethodOwnedByCustomer(
            paymentMethodId,
            stripeCustomerId
        );

        if (!pm.customer) {
            pm = await attachPaymentMethodToCustomer(stripeCustomerId, paymentMethodId);
        }

        if (pm.type && pm.type !== "card") {
            throw new ValidationError("Only card payment methods are supported");
        }

        await this._persistDefaultCard(user, pm);
        const bookingsUpdated = await this.syncOpenBookingsPaymentMethod(
            userId,
            pm.id
        );

        const list = await this.listPaymentMethods(userId);
        return {
            ...list,
            activatedPaymentMethodId: pm.id,
            openBookingsUpdated: bookingsUpdated,
            message:
                "Card saved and set as active. Open card bookings will use this card.",
        };
    }

    /**
     * Switch active card among already-attached methods (still only one active).
     */
    async setDefaultPaymentMethod(userId, paymentMethodId) {
        if (!paymentMethodId || typeof paymentMethodId !== "string") {
            throw new ValidationError("paymentMethodId is required");
        }

        const user = await this._getCustomerUser(userId);
        const stripeCustomerId = await this._ensureStripeCustomer(user);
        const pm = await this._assertPaymentMethodOwnedByCustomer(
            paymentMethodId,
            stripeCustomerId
        );

        if (!pm.customer) {
            throw new ValidationError(
                "Payment method is not attached. Use add card flow first."
            );
        }
        if (pm.type && pm.type !== "card") {
            throw new ValidationError("Only card payment methods are supported");
        }

        await this._persistDefaultCard(user, pm);
        const bookingsUpdated = await this.syncOpenBookingsPaymentMethod(
            userId,
            pm.id
        );

        const list = await this.listPaymentMethods(userId);
        return {
            ...list,
            activatedPaymentMethodId: pm.id,
            openBookingsUpdated: bookingsUpdated,
            message: "Active card updated",
        };
    }

    /**
     * Remove a saved card. If it was active, promote another card if any remain.
     */
    async removePaymentMethod(userId, paymentMethodId) {
        if (!paymentMethodId || typeof paymentMethodId !== "string") {
            throw new ValidationError("paymentMethodId is required");
        }

        const user = await this._getCustomerUser(userId);
        if (!user.stripeCustomerId) {
            throw new ValidationError("No Stripe customer on file");
        }

        const pm = await this._assertPaymentMethodOwnedByCustomer(
            paymentMethodId,
            user.stripeCustomerId
        );
        if (!pm.customer) {
            throw new ValidationError("Payment method is not attached to this customer");
        }

        const wasDefault = user.defaultPaymentMethodId === paymentMethodId;
        await detachPaymentMethod(paymentMethodId);

        let promotedId = null;
        if (wasDefault) {
            const remaining = await listCustomerCardPaymentMethods(user.stripeCustomerId);
            if (remaining.length > 0) {
                await this._persistDefaultCard(user, remaining[0]);
                promotedId = remaining[0].id;
                await this.syncOpenBookingsPaymentMethod(userId, promotedId);
            } else {
                await user.update({
                    defaultPaymentMethodId: null,
                    cardBrand: null,
                    cardLast4: null,
                    cardExpMonth: null,
                    cardExpYear: null,
                    cardUpdatedAt: new Date(),
                });
            }
        }

        const list = await this.listPaymentMethods(userId);
        return {
            ...list,
            removedPaymentMethodId: paymentMethodId,
            activatedPaymentMethodId: promotedId,
            message: wasDefault
                ? promotedId
                    ? "Card removed. Another card is now active."
                    : "Card removed. No active card left."
                : "Card removed",
        };
    }
}

module.exports = new CustomerPaymentMethodService();
