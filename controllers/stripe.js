require("dotenv").config();
const { STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY } = process.env;
const stripe = require("stripe")(STRIPE_SECRET_KEY);
const customError = require("../middlewares/customError");

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
        throw new AppError(`${error.message} `, 200);
    }
}


/*
 *   Create PaymentIntent
 */
async function createPaymentIntend(amount, customerId, paymentMethodId) {
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: convertToCents(amount),
            currency: 'gbp',
            payment_method: paymentMethodId,
            customer: customerId,
            capture_method: 'manual',
        })
        //Confirm
        const confirmIntent = await stripe.paymentIntents.confirm(
            paymentIntent.id,
            { payment_method: paymentMethodId },
        )
        return confirmIntent.id
    } catch (error) {
        throw new AppError(`${error.message} `, 200)
    }
}


/*
 *   GET PaymenIntend
 */
async function paymentIntentGet(paymentIntentId) {
    try {
        const paymentIntent = await stripe.paymentMethods.retrieve(paymentIntentId)
        return paymentIntent
    } catch (error) {
        throw new AppError(`${error.message} `, 200)
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
        throw new AppError(`${error.message} `, 200)
    }
}
















module.exports = {
    createStripeCustomer,
    createPaymentIntendForUpFrontPayments,
    createPaymentIntend,
    paymentIntentGet,
    confirmIntend
};
