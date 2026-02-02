require("dotenv").config();
const { STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY } = process.env;
const stripe = require("stripe")(STRIPE_SECRET_KEY);
const customError = require("../middlewares/customError");


// Amount to Cents
function convertToCents(amount) {
    return Math.round(amount * 100);
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


/*
 *   Charge immediately using saved payment method (ONE STEP - no user interaction)
 */
async function chargeOffSession(amount, customerId, paymentMethodId) {
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: convertToCents(amount),
            currency: 'usd',
            customer: customerId,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,  // Confirm immediately
            // No capture_method means it auto-captures (charges immediately)
        });
        return paymentIntent;
    } catch (error) {
        throw new customError(`${error.message}`, 400);
    }
}


/*
 *   Create Setup Intent (for saving card without charging)
 */
async function createSetupIntent(customerId) {
    try {
        const setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            payment_method_types: ['card'],
            usage: 'off_session',
        })
        return setupIntent
    } catch (error) {
        throw new customError(`${error.message} `, 200)
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

/*
 *    Create PaymentIntent for Agent
 */
async function createPaymentIntentForAgent(newAmount, customerId, savedPaymentMethodId) {
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: convertToCents(newAmount),
            currency: 'usd',
            customer: customerId,
            payment_method: savedPaymentMethodId,
            off_session: true,
            confirm: true,
        });
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
        throw new customError(`${error.message} `, 200)
    }
}








module.exports = {
    createStripeCustomer,
    createPaymentIntendForUpFrontPayments,
    createPaymentIntend,
    createSetupIntent,
    paymentIntentGet,
    confirmIntend,
    getIntent,
    confirmAndCapturePayment,
    createPaymentIntentForAgent,
    attachPaymentMethodToCustomer,
    chargeOffSession
};
