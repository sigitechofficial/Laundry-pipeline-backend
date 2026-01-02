const nodemailer=require('nodemailer')
const transpoter=nodemailer.createTransport({
    host:process.env.EMAIL_HOST,
    port:process.env.EMAIL_PORT,
    secure: process.env.EMAIL_PORT == 465, // true for 465, false for other ports
    auth:{
        user:process.env.EMAIL_USERNAME,
        pass:process.env.EMAIL_PASSWORD
    },
    tls: {
        // Do not fail on invalid certificates (for development/testing)
        rejectUnauthorized: false
    }
})


module.exports=transpoter