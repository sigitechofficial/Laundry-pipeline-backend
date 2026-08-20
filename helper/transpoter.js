require('dotenv').config();
const nodemailer=require('nodemailer')

// SMTP configuration must be injected at runtime. Never commit SMTP credentials.
const FROM_ADDRESS = process.env.EMAIL_FROM || 'noreply@serviprapp.com';
const SMTP_HOST = process.env.EMAIL_HOST || process.env.SMTP_HOST || 'smtp.zeptomail.com';
const SMTP_PORT = parseInt(process.env.EMAIL_PORT || process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.EMAIL_USER || process.env.SMTP_USER;
const SMTP_PASS = process.env.EMAIL_PASSWORD || process.env.SMTP_PASS;

// Log configuration (without exposing password)
console.log('📧 Email Configuration:');
console.log('   Host:', SMTP_HOST);
console.log('   Port:', SMTP_PORT);
console.log('   SMTP User (auth):', SMTP_USER);
console.log('   From Address:', FROM_ADDRESS);
console.log('   Password:', SMTP_PASS ? '***' + SMTP_PASS.slice(-4) : 'NOT SET');
console.log('   Secure:', SMTP_PORT === 465);
console.log('   Connection Type:', SMTP_PORT === 465 ? 'SSL' : 'STARTTLS');

const transpoter=nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465 (SSL), false for 587 (STARTTLS)
    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
    },
    // Connection timeout
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
})

// Verify transporter configuration on startup
transpoter.verify(function(error, success) {
    if (error) {
        console.error('❌ Email transporter verification failed:', error.message);
        console.error('Error code:', error.code);
        console.error('Response:', error.response);
        console.error('Response Code:', error.responseCode);
        console.error('Command:', error.command);
        
        // Provide helpful error messages
        if (error.code === 'ESOCKET' || error.message.includes('wrong version number')) {
            console.error('\n🔌 SSL/TLS Connection Error - cPanel Server Fix:');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('The SSL connection failed. This is common on cPanel servers.');
            console.error('');
            console.error('✅ SOLUTION: Use port 587 with STARTTLS instead of port 465');
            console.error('   Set in your .env file:');
            console.error('   EMAIL_PORT=587');
            console.error('');
            console.error('   Or update the default in transporter.js:');
            console.error('   const SMTP_PORT = parseInt(process.env.EMAIL_PORT || "587", 10);');
            console.error('   secure: false  // for port 587');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        } else if (error.code === 'EAUTH') {
            console.error('\n🔐 Authentication Error (535) - ZeptoMail SMTP:');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('The SMTP server rejected your credentials.');
            console.error('');
            console.error('✅ For ZeptoMail, check your .env file has:');
            console.error('   EMAIL_HOST=smtp.zeptomail.com');
            console.error('   EMAIL_PORT=587');
            console.error('   EMAIL_USER=emailapikey');
            console.error('   EMAIL_PASSWORD=your-full-api-token-here');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        } else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
            console.error('\n🌐 Connection Error - Possible solutions:');
            console.error('1. Check if EMAIL_HOST is correct');
            console.error('2. Check if EMAIL_PORT is correct (587 for STARTTLS, 465 for SSL)');
            console.error('3. Check your internet connection');
            console.error('4. Check if firewall is blocking the connection');
        }
    } else {
        console.log('✅ Email transporter verified successfully');
        console.log('📧 Ready to send emails');
    }
});

// Export test function for manual testing
transpoter.testConnection = function(callback) {
    this.verify(function(error, success) {
        if (error) {
            console.error('❌ Connection test failed');
            if (callback) callback(error, null);
        } else {
            console.log('✅ Connection test passed');
            if (callback) callback(null, success);
        }
    });
};

module.exports=transpoter