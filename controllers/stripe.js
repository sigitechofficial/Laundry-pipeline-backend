require("dotenv").config();
const { STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY } = process.env;
const stripe=require('stripe')(STRIPE_SECRET_KEY)
const customError=require('../middlewares/customError')

async function createStripeCustomer(name,email) {
    try {
        const customerCreate=await stripe.customers.create({name,email})

        return customerCreate.id
        
    } catch (error) {
        throw new customError(error.message,error.code);
        
    }
    
}


module.exports={
    createStripeCustomer
}