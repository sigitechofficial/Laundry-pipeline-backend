require("dotenv").config();
const { STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY } = process.env;
const stripe = require("stripe")(STRIPE_SECRET_KEY);
const customError = require("../middlewares/customError");


// Amount to Cents
function convertToCents(amount) {
    return Math.round(amount * 100);
}

function sanitizeStripeMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") {
        return undefined;
    }

    const normalized = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (value === null || value === undefined || value === "") {
            continue;
        }
        normalized[String(key).slice(0, 40)] = String(value).slice(0, 500);
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function applyStripePresentationFields(params, stripeOptions = {}) {
    if (!stripeOptions || typeof stripeOptions !== "object") {
        return;
    }

    if (stripeOptions.description) {
        params.description = String(stripeOptions.description).slice(0, 1000);
    }

    const metadata = sanitizeStripeMetadata(stripeOptions.metadata);
    if (metadata) {
        params.metadata = metadata;
    }

    if (stripeOptions.statementDescriptorSuffix) {
        params.statement_descriptor_suffix = String(
            stripeOptions.statementDescriptorSuffix
        )
            .slice(0, 22)
            .replace(/[<>'"\\*]/g, "");
    }
}


/*
 *   Create Customer
 */
async function createStripeCustomer(name, email) {
    try {
        const customerCreate = await stripe.customers.create({ name, email });

        return customerCreate.id;
    } catch (error) {
        throw new customError(error.message, error.code);
    }
}


//!==============================Payment Intents=========================//
/*
 *   Create PaymenIntend for Upfront Payments with AccountId of Connect Account
 */
async function createPaymentIntendForUpFrontPayments(
    amount,
    customerId,
    accountId
) {
    console.log("🚀 ~ amount:", amount);
    console.log("ðŸš€ ~ accountId:", accountId);
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: convertToCents(amount),
            currency: "gbp",
            setup_future_usage: "off_session",
            customer: customerId,
            // capture_method: "manual",
            automatic_payment_methods: {
                enabled: true,
            },
            application_fee_amount: 50,
            transfer_data: {
                destination: accountId, // Replace with the Connect account ID
            },
        });

        return paymentIntent;
    } catch (error) {
        throw new customError(`${error.message} `, 200);
    }
}


/*
 *   Create PaymentIntent (with optional payment method for off-session use)
 */
async function createPaymentIntend(amount, customerId, paymentMethodId = null) {
    try {
        const params = {
            amount: convertToCents(amount),
            currency: 'usd',
            customer: customerId,
            capture_method: 'manual',
        };

        // If payment method provided, attach it to avoid automatic payment methods
        if (paymentMethodId) {
            params.payment_method = paymentMethodId;
            params.off_session = true;
            params.confirm = false;
        }

        const paymentIntent = await stripe.paymentIntents.create(params);
        return paymentIntent;
    } catch (error) {
        throw new customError(`${error.message} `, 200);
    }
}


/**
 * Authorize (hold) amount on a saved card without capturing.
 * Status should become `requires_capture` on success.
 *
 * @param {number} amount - major currency units (e.g. GBP)
 * @param {string} customerId - Stripe customer ID
 * @param {string} paymentMethodId
 * @param {string} [idempotencyKey]
 * @param {object} [stripeOptions] - presentation / metadata fields
 */
async function createAuthorizationHold(
    amount,
    customerId,
    paymentMethodId,
    idempotencyKey = null,
    stripeOptions = {}
) {
    if (!amount || Number(amount) <= 0) {
        throw new customError("Authorization amount must be greater than 0", 400);
    }
    if (!customerId || !paymentMethodId) {
        throw new customError(
            "Stripe customer and payment method are required for authorization hold",
            400
        );
    }

    try {
        const params = {
            amount: convertToCents(amount),
            currency: "gbp",
            customer: customerId,
            payment_method: paymentMethodId,
            capture_method: "manual",
            confirm: true,
            off_session: true,
            // Do NOT set setup_future_usage here: Stripe rejects
            // off_session=true + setup_future_usage on confirm.
            // Card is already saved via SetupIntent at checkout.
        };

        applyStripePresentationFields(params, stripeOptions);

        const options = {};
        if (idempotencyKey) {
            options.idempotencyKey = String(idempotencyKey).slice(0, 255);
        }

        const paymentIntent = await stripe.paymentIntents.create(params, options);

        if (
            paymentIntent.status !== "requires_capture" &&
            paymentIntent.status !== "succeeded"
        ) {
            throw new customError(
                `Authorization hold failed with status: ${paymentIntent.status}`,
                400
            );
        }

        console.log(
            `✅ Auth hold created: ${paymentIntent.id}, status=${paymentIntent.status}, amount=${amount}`
        );
        return paymentIntent;
    } catch (error) {
        if (error instanceof customError) throw error;
        if (error.type === "idempotency_error") {
            throw new customError(
                `Authorization already processed with this idempotency key: ${error.message}`,
                400
            );
        }
        throw new customError(`Stripe Authorization Error: ${error.message}`, 400);
    }
}

/**
 * Update PaymentIntent description / metadata (e.g. after capture or refund).
 */
async function updatePaymentIntentPresentation(
    paymentIntentId,
    stripeOptions = {},
    { mergeMetadata = true } = {}
) {
    if (!paymentIntentId) {
        throw new customError("paymentIntentId is required for update", 400);
    }

    try {
        const params = {};
        if (stripeOptions.description) {
            params.description = String(stripeOptions.description).slice(0, 1000);
        }

        let metadata = sanitizeStripeMetadata(stripeOptions.metadata);
        if (mergeMetadata && metadata) {
            const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
            metadata = {
                ...(existing.metadata || {}),
                ...metadata,
            };
        }
        if (metadata && Object.keys(metadata).length > 0) {
            params.metadata = metadata;
        }

        if (stripeOptions.statementDescriptorSuffix) {
            params.statement_descriptor_suffix = String(
                stripeOptions.statementDescriptorSuffix
            )
                .slice(0, 22)
                .replace(/[<>'"\\*]/g, "");
        }

        if (Object.keys(params).length === 0) {
            return stripe.paymentIntents.retrieve(paymentIntentId);
        }

        const updated = await stripe.paymentIntents.update(paymentIntentId, params);
        console.log(
            `✅ Updated PaymentIntent presentation: ${paymentIntentId}`
        );
        return updated;
    } catch (error) {
        if (error instanceof customError) throw error;
        throw new customError(
            `Stripe PaymentIntent Update Error: ${error.message}`,
            400
        );
    }
}

/**
 * Capture a previously authorized PaymentIntent (full amount by default).
 */
async function capturePaymentIntent(paymentIntentId, options = {}) {
    if (!paymentIntentId) {
        throw new customError("paymentIntentId is required for capture", 400);
    }

    try {
        let intent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (intent.status === "succeeded") {
            return { ...intent, alreadyCaptured: true };
        }

        if (intent.status === "canceled") {
            throw new customError("PaymentIntent was canceled; cannot capture", 400);
        }

        if (intent.status !== "requires_capture") {
            throw new customError(
                `Cannot capture PaymentIntent in status: ${intent.status}`,
                400
            );
        }

        const captureParams = {};
        if (
            options.amount != null &&
            Number.isFinite(Number(options.amount)) &&
            Number(options.amount) > 0
        ) {
            captureParams.amount_to_capture = convertToCents(Number(options.amount));
        }

        const requestOptions = {};
        if (options.idempotencyKey) {
            requestOptions.idempotencyKey = String(options.idempotencyKey).slice(
                0,
                255
            );
        }

        intent = await stripe.paymentIntents.capture(
            paymentIntentId,
            captureParams,
            requestOptions
        );

        if (options.stripeOptions) {
            try {
                intent = await updatePaymentIntentPresentation(
                    paymentIntentId,
                    options.stripeOptions,
                    { mergeMetadata: true }
                );
            } catch (updateErr) {
                console.warn(
                    `⚠️ Capture succeeded but description update failed for ${paymentIntentId}:`,
                    updateErr.message
                );
            }
        }

        return intent;
    } catch (error) {
        if (error instanceof customError) throw error;
        throw new customError(`Stripe Capture Error: ${error.message}`, 400);
    }
}

/**
 * Release an uncaptured authorization hold (cancel PaymentIntent).
 * No-op-safe if already canceled; errors if already succeeded (use refund instead).
 */
async function cancelPaymentIntent(paymentIntentId, options = {}) {
    if (!paymentIntentId) {
        throw new customError("paymentIntentId is required to release hold", 400);
    }

    try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (intent.status === "canceled") {
            return { ...intent, alreadyCanceled: true };
        }

        if (intent.status === "succeeded") {
            throw new customError(
                "PaymentIntent already captured; cancel hold is not valid — use refund",
                400
            );
        }

        if (intent.status !== "requires_capture") {
            throw new customError(
                `Cannot cancel PaymentIntent in status: ${intent.status}`,
                400
            );
        }

        const requestOptions = {};
        if (options.idempotencyKey) {
            requestOptions.idempotencyKey = String(options.idempotencyKey).slice(
                0,
                255
            );
        }

        const canceled = await stripe.paymentIntents.cancel(
            paymentIntentId,
            {
                cancellation_reason:
                    options.cancellation_reason || "requested_by_customer",
            },
            requestOptions
        );
        return canceled;
    } catch (error) {
        if (error instanceof customError) throw error;
        throw new customError(`Stripe Cancel PI Error: ${error.message}`, 400);
    }
}

/*
 *   Charge immediately using saved payment method (ONE STEP - no user interaction)
 *   With Idempotency Key support to prevent duplicate charges
 * 
 *   @param {number} amount - Amount to charge
 *   @param {string} customerId - Stripe customer ID
 *   @param {string} paymentMethodId - Saved payment method ID
 *   @param {string} idempotencyKey - Optional idempotency key for preventing duplicate charges
 *   @returns {Object} Stripe PaymentIntent object
 */
async function chargeOffSession(
    amount,
    customerId,
    paymentMethodId,
    idempotencyKey = null,
    stripeOptions = {}
) {
    try {
        const params = {
            amount: convertToCents(amount),
            currency: 'gbp',
            customer: customerId,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,  // Confirm immediately
            // No capture_method means it auto-captures (charges immediately)
        };

        applyStripePresentationFields(params, stripeOptions);

        // Add idempotency key if provided (CRITICAL for preventing duplicate charges)
        const options = {};
        if (idempotencyKey) {
            options.idempotencyKey = idempotencyKey;
            console.log(`🔒 Using idempotency key: ${idempotencyKey}`);
        }

        const paymentIntent = await stripe.paymentIntents.create(params, options);

        console.log(`✅ Payment charged successfully: ${paymentIntent.id}, Status: ${paymentIntent.status}`);
        return paymentIntent;
    } catch (error) {
        // Stripe returns the SAME result if idempotency key is reused (safe retry)
        if (error.type === 'idempotency_error') {
            console.log('⚠️ Idempotency key already used - returning previous result');
            // Re-throw with clearer message
            throw new customError(`Payment already processed with this idempotency key: ${error.message}`, 400);
        }
        const wrapped = new customError(`Stripe Error: ${error.message}`, 400);
        wrapped.stripeCode = error.code || null;
        wrapped.declineCode = error.decline_code || null;
        wrapped.raw = error.raw || error;
        throw wrapped;
    }
}


/*
 *   Create Setup Intent (for saving card without charging)
 */
async function createSetupIntent(customerId) {
    try {
        const setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            usage: 'off_session',
            automatic_payment_methods: {
                enabled: true,
            },
        });
        return setupIntent;
    } catch (error) {
        throw new customError(`${error.message} `, 200);
    }
}

/**
 * Ephemeral key so PaymentSheet can list the customer's saved payment methods.
 * @param {string} customerId - Stripe customer id (cus_…)
 * @param {string} [stripeApiVersion] - API version from the mobile SDK (optional)
 */
async function createEphemeralKey(customerId, stripeApiVersion) {
    if (!customerId) {
        throw new customError("customerId is required for ephemeral key", 400);
    }
    try {
        // Must be a version the mobile Stripe SDK understands.
        const apiVersion = stripeApiVersion || "2024-06-20";
        const key = await stripe.ephemeralKeys.create(
            { customer: customerId },
            { apiVersion }
        );
        return key;
    } catch (error) {
        throw new customError(`Ephemeral key error: ${error.message}`, 400);
    }
}


/*
 *   GET Payment Method
 */
async function paymentIntentGet(paymentIntentId) {
    try {
        const paymentIntent = await stripe.paymentMethods.retrieve(paymentIntentId)
        return paymentIntent
    } catch (error) {
        throw new customError(`${error.message} `, 200)
    }
}


/*
 *   GET PaymentIntent
 */
async function getIntent(paymentIntentId) {
    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)
        return paymentIntent
    } catch (error) {
        throw new customError(`${error.message} `, 200)
    }
}

/**
 * List PaymentIntents for a Stripe customer (newest first).
 * Used to rediscover pickup + invoice charges when booking.paymentIntentId was overwritten.
 */
async function listPaymentIntentsForCustomer(stripeCustomerId, options = {}) {
    if (!stripeCustomerId) return [];
    const maxPages = Math.min(Number(options.maxPages) || 3, 5);
    const out = [];
    let startingAfter;
    try {
        for (let page = 0; page < maxPages; page += 1) {
            const pageResult = await stripe.paymentIntents.list({
                customer: stripeCustomerId,
                limit: 100,
                ...(startingAfter ? { starting_after: startingAfter } : {}),
            });
            const rows = pageResult.data || [];
            out.push(...rows);
            if (!pageResult.has_more || !rows.length) break;
            startingAfter = rows[rows.length - 1].id;
        }
        return out;
    } catch (error) {
        console.error(
            "[stripe] listPaymentIntentsForCustomer failed:",
            error.message
        );
        return out;
    }
}



/*
 *    Confirm PaymenIntend
 */
async function confirmIntend(paymentIntentId, paymentMethodId) {
    try {
        const confirmIntent = await stripe.paymentIntents.confirm(paymentIntentId, {
            payment_method: paymentMethodId,
        })
        return confirmIntent
    } catch (error) {
        throw new customError(`${error.message} `, 200)
    }
}



/*
 *    Confirm PaymenIntend and Capture the Payment
 */
async function confirmAndCapturePayment(paymentIntentId, paymentMethodId, customerId) {
    console.log("customerId------->", customerId)
    try {
        let intent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (
            (intent.status === "requires_payment_method" ||
                intent.status === "requires_confirmation") &&
            paymentMethodId
        ) {
            intent = await stripe.paymentIntents.confirm(paymentIntentId, {
                payment_method: paymentMethodId
            });
        }

        if (intent.status === "requires_capture") {
            intent = await stripe.paymentIntents.capture(paymentIntentId);
        }

        return intent;
    } catch (error) {
        throw new customError(`Stripe Error: ${error.message}`, 400);
    }
}

/**
 * Refund a succeeded PaymentIntent (full or partial).
 * @param {string} paymentIntentId
 * @param {number} [amount] - major currency units (e.g. GBP). Omit for full refund.
 * @param {{ reason?: string, idempotencyKey?: string, metadata?: object }} [options]
 */
async function refundPaymentIntent(paymentIntentId, amount, options = {}) {
    if (!paymentIntentId) {
        throw new customError("paymentIntentId is required for refund", 400);
    }

    try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (!intent) {
            throw new customError("PaymentIntent not found", 404);
        }

        if (intent.status !== "succeeded") {
            throw new customError(
                `Cannot refund PaymentIntent in status: ${intent.status}`,
                400
            );
        }

        const refundableCents = intent.amount_received
            ? Number(intent.amount_received) - Number(intent.amount_refunded || 0)
            : 0;

        if (refundableCents <= 0) {
            return {
                id: null,
                status: "already_refunded",
                amount: 0,
                payment_intent: paymentIntentId,
                alreadyRefunded: true,
            };
        }

        const params = {
            payment_intent: paymentIntentId,
            reason: options.reason || "requested_by_customer",
        };

        if (amount != null && Number.isFinite(Number(amount)) && Number(amount) > 0) {
            const cents = convertToCents(Number(amount));
            params.amount = Math.min(cents, refundableCents);
        }

        const metadata = sanitizeStripeMetadata(options.metadata);
        if (metadata) {
            params.metadata = metadata;
        }

        const requestOptions = {};
        if (options.idempotencyKey) {
            requestOptions.idempotencyKey = String(options.idempotencyKey).slice(
                0,
                255
            );
        }

        const refund = await stripe.refunds.create(params, requestOptions);

        if (options.stripeOptions) {
            try {
                await updatePaymentIntentPresentation(
                    paymentIntentId,
                    options.stripeOptions,
                    { mergeMetadata: true }
                );
            } catch (updateErr) {
                console.warn(
                    `⚠️ Refund succeeded but description update failed for ${paymentIntentId}:`,
                    updateErr.message
                );
            }
        }

        return refund;
    } catch (error) {
        if (error instanceof customError) throw error;
        throw new customError(`Stripe Refund Error: ${error.message}`, 400);
    }
}

/*
 *    Create PaymentIntent for Agent
 */
async function createPaymentIntentForAgent(
    newAmount,
    customerId,
    savedPaymentMethodId,
    stripeOptions = {}
) {
    try {
        const params = {
            amount: convertToCents(newAmount),
            currency: 'gbp',
            customer: customerId,
            payment_method: savedPaymentMethodId,
            off_session: true,
            confirm: true,
        };

        applyStripePresentationFields(params, stripeOptions);

        const paymentIntent = await stripe.paymentIntents.create(params);
        return paymentIntent
    } catch (error) {
        throw new customError(`${error.message} `, 200)
    }
}

/*
 *    Attach Payment Method to Customer
 */
async function attachPaymentMethodToCustomer(customerId, savedPaymentMethodId) {
    try {
        const paymentMethod = await stripe.paymentMethods.attach(savedPaymentMethodId, {
            customer: customerId,
        });
        return paymentMethod
    } catch (error) {
        // Already attached to this customer is fine for idempotent add flows
        if (error && String(error.message || "").includes("already been attached")) {
            return stripe.paymentMethods.retrieve(savedPaymentMethodId);
        }
        throw new customError(`${error.message} `, 200)
    }
}

/**
 * List card payment methods for a Stripe customer.
 */
async function listCustomerCardPaymentMethods(stripeCustomerId) {
    try {
        const result = await stripe.paymentMethods.list({
            customer: stripeCustomerId,
            type: "card",
            limit: 100,
        });
        return result.data || [];
    } catch (error) {
        throw new customError(`Stripe Error: ${error.message}`, 400);
    }
}

/**
 * Retrieve a single payment method.
 */
async function retrievePaymentMethod(paymentMethodId) {
    try {
        return await stripe.paymentMethods.retrieve(paymentMethodId);
    } catch (error) {
        throw new customError(`Stripe Error: ${error.message}`, 400);
    }
}

/**
 * Detach a payment method from its customer.
 */
async function detachPaymentMethod(paymentMethodId) {
    try {
        return await stripe.paymentMethods.detach(paymentMethodId);
    } catch (error) {
        throw new customError(`Stripe Error: ${error.message}`, 400);
    }
}

/**
 * Set Stripe customer's invoice default payment method (active card).
 */
async function setStripeCustomerDefaultPaymentMethod(stripeCustomerId, paymentMethodId) {
    try {
        return await stripe.customers.update(stripeCustomerId, {
            invoice_settings: {
                default_payment_method: paymentMethodId,
            },
        });
    } catch (error) {
        throw new customError(`Stripe Error: ${error.message}`, 400);
    }
}

/*
 *   Create Stripe Connect Account
 */
async function createStripeConnectAccount(email, country = 'GB') {
    try {
        const account = await stripe.accounts.create({
            type: 'express',
            country: country,
            email: email,
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
        });
        return account.id; // Returns the Connect account ID
    } catch (error) {
        throw new customError(`Stripe Connect Account Error: ${error.message}`, 400);
    }
}

/*
 *   Create Stripe Onboarding Link
 */
async function createStripeOnboardingLink(accountId, returnUrl, refreshUrl) {
    try {
        // Verify account exists before creating link
        if (!accountId) {
            throw new Error('Account ID is required to create onboarding link');
        }

        // Verify the account exists in Stripe
        try {
            const account = await stripe.accounts.retrieve(accountId);
            console.log('✅ Verified Stripe account exists:', account.id);
            console.log('   Account type:', account.type);
            console.log('   Account country:', account.country);
        } catch (verifyError) {
            console.error('❌ Failed to verify Stripe account:', verifyError.message);
            throw new Error(`Stripe account ${accountId} does not exist or cannot be accessed: ${verifyError.message}`);
        }

        // Default URL if not provided
        const defaultUrl = 'https://prodlaundry.sigisolutions.net/app/BottomBarScreen';
        const finalReturnUrl = returnUrl || defaultUrl;
        const finalRefreshUrl = 'https://example.com/reauth';

        console.log('🔗 Creating account link...');
        console.log('   Account ID:', accountId);
        console.log('   Return URL:', finalReturnUrl);
        console.log('   Refresh URL:', finalRefreshUrl);

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: finalRefreshUrl,
            return_url: finalReturnUrl,
            type: 'account_onboarding',
        });

        if (!accountLink || !accountLink.url) {
            throw new Error('Failed to create account link - no URL returned from Stripe');
        }

        console.log('✅ Account link created successfully:', accountLink.url);
        return accountLink.url; // Returns the onboarding URL
    } catch (error) {
        console.error('❌ Stripe Onboarding Link Error:', error.message);
        throw new customError(`Stripe Onboarding Link Error: ${error.message}`, 400);
    }
}

/*
 *   Check if Connect Account is fully onboarded
 */
async function checkConnectAccountStatus(accountId) {
    try {
        const account = await stripe.accounts.retrieve(accountId);
        return {
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            detailsSubmitted: account.details_submitted,
            transfersEnabled: account.capabilities?.transfers === "active",
        };
    } catch (error) {
        throw new customError(`Stripe Account Status Error: ${error.message}`, 400);
    }
}

/**
 * Transfer platform funds into an agent's Stripe Connect balance.
 *
 * Stripe subsequently pays the connected balance to the agent's bank according
 * to that Connect account's payout schedule.
 */
async function transferToConnectAccount(
    amount,
    accountId,
    idempotencyKey,
    metadata = {}
) {
    const amountInCents = convertToCents(amount);
    if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
        throw new customError("Transfer amount must be greater than 0", 400);
    }
    if (!accountId) {
        throw new customError("Stripe Connect account is required", 400);
    }

    try {
        return await stripe.transfers.create(
            {
                amount: amountInCents,
                currency: "gbp",
                destination: accountId,
                description:
                    metadata.transferKind === "admin_payout"
                        ? "Admin payout to agent Stripe Connect account"
                        : "Agent wallet withdrawal",
                metadata: sanitizeStripeMetadata(metadata),
            },
            {
                idempotencyKey: String(idempotencyKey).slice(0, 255),
            }
        );
    } catch (error) {
        throw new customError(`Stripe transfer failed: ${error.message}`, 400);
    }
}

/*
 *   Create Stripe Account Link for Onboarding
 *   @param {string} accountId - Stripe Connect account ID
 *   @returns {string} Onboarding URL
 */
async function createStripeAccountLink(accountId) {
    try {
        if (!accountId) {
            throw new Error('Account ID is required to create account link');
        }

        const returnUrl = 'https://prodlaundry.sigisolutions.net/app/BottomBarScreen';

        console.log('🔗 Creating account link...');
        console.log('   Account ID:', accountId);
        console.log('   Return URL:', returnUrl);

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            return_url: returnUrl, // Required by Stripe
            refresh_url: returnUrl, // Use same URL for refresh
            type: "account_onboarding",
        });

        if (!accountLink || !accountLink.url) {
            throw new Error('Failed to create account link - no URL returned from Stripe');
        }

        console.log('✅ Account link created successfully:', accountLink.url);
        return accountLink.url;
    } catch (error) {
        console.error('❌ Stripe Account Link Error:', error.message);
        throw new customError(`Stripe Account Link Error: ${error.message}`, 400);
    }
}


/*
 *   Create Stripe Connect Account with Onboarding Link
 *   @param {string} email - Email address for the account
 *   @param {string} country - Country code (default: 'GB')
 *   @returns {Object} Object containing accountLink URL and accountId
 */
async function createConnectAccount(email, country = 'GB') {
    try {
        if (!email) {
            throw new Error('Email is required to create Connect account');
        }

        console.log('🔗 Creating Stripe Connect account...');
        console.log('   Email:', email);
        console.log('   Country:', country);

        const account = await stripe.accounts.create({
            type: "express",
            country: country,
            email: email,
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
        });

        if (!account || !account.id) {
            throw new Error('Failed to create Stripe Connect account - no account ID returned');
        }

        console.log('✅ Stripe Connect account created:', account.id);

        const returnUrl = 'https://prodlaundry.sigisolutions.net/app/BottomBarScreen';

        console.log('🔗 Creating onboarding link...');
        console.log('   Return URL:', returnUrl);

        const accountLink = await stripe.accountLinks.create({
            account: account.id,
            return_url: returnUrl, // Required by Stripe
            refresh_url: returnUrl, // Use same URL for refresh
            type: "account_onboarding",
        });

        if (!accountLink || !accountLink.url) {
            throw new Error('Failed to create account link - no URL returned from Stripe');
        }

        console.log('✅ Onboarding link created successfully:', accountLink.url);

        return {
            accountLink: accountLink.url,
            accountId: account.id
        };
    } catch (error) {
        console.error('❌ Create Connect Account Error:', error.message);
        throw new customError(`Create Connect Account Error: ${error.message}`, 400);
    }
}




module.exports = {
    createStripeCustomer,
    createPaymentIntendForUpFrontPayments,
    createPaymentIntend,
    createSetupIntent,
    createEphemeralKey,
    paymentIntentGet,
    confirmIntend,
    getIntent,
    listPaymentIntentsForCustomer,
    confirmAndCapturePayment,
    createAuthorizationHold,
    capturePaymentIntent,
    cancelPaymentIntent,
    updatePaymentIntentPresentation,
    refundPaymentIntent,
    createPaymentIntentForAgent,
    attachPaymentMethodToCustomer,
    listCustomerCardPaymentMethods,
    retrievePaymentMethod,
    detachPaymentMethod,
    setStripeCustomerDefaultPaymentMethod,
    chargeOffSession,
    createStripeConnectAccount,
    createStripeOnboardingLink,
    checkConnectAccountStatus,
    transferToConnectAccount,
    createStripeAccountLink,
    createConnectAccount
};
