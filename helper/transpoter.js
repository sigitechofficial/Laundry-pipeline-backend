const nodemailer=require('nodemailer')

// Validate required environment variables
if (!process.env.EMAIL_HOST || !process.env.EMAIL_PORT || !process.env.EMAIL_USERNAME || !process.env.EMAIL_PASSWORD) {
    console.error('❌ Email configuration error: Missing required environment variables');
    console.error('Required: EMAIL_HOST, EMAIL_PORT, EMAIL_USERNAME, EMAIL_PASSWORD');
}

// Parse port as integer
const emailPort = parseInt(process.env.EMAIL_PORT, 10);

// Log configuration (without exposing password)
console.log('📧 Email Configuration:');
console.log('   Host:', process.env.EMAIL_HOST);
console.log('   Port:', emailPort);
console.log('   Username:', process.env.EMAIL_USERNAME);
console.log('   Password:', process.env.EMAIL_PASSWORD ? '***' + process.env.EMAIL_PASSWORD.slice(-4) : 'NOT SET');
console.log('   Secure:', emailPort === 465);

const transpoter=nodemailer.createTransport({
    host:process.env.EMAIL_HOST,
    port: emailPort,
    secure: emailPort === 465, // true for 465, false for other ports
    auth:{
        user:process.env.EMAIL_USERNAME,
        pass:process.env.EMAIL_PASSWORD
    },
    tls: {
        // Do not fail on invalid certificates (for development/testing)
        rejectUnauthorized: false
    },
    // Add connection timeout
    connectionTimeout: 10000, // 10 seconds
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
        if (error.code === 'EAUTH') {
            console.error('\n🔐 Authentication Error (535) - Detailed Solutions:');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('The SMTP server rejected your credentials.');
            console.error('');
            console.error('✅ SOLUTION 1: For Gmail Users (Most Common):');
            console.error('   1. Go to: https://myaccount.google.com/apppasswords');
            console.error('   2. Sign in with your Google account');
            console.error('   3. Select "Mail" and "Other (Custom name)"');
            console.error('   4. Enter name: "Laundry App"');
            console.error('   5. Click "Generate"');
            console.error('   6. Copy the 16-character password (no spaces)');
            console.error('   7. Update EMAIL_PASSWORD in your .env file');
            console.error('   8. Restart your server');
            console.error('');
            console.error('✅ SOLUTION 2: Check Your Credentials:');
            console.error('   - EMAIL_USERNAME should be your full email address');
            console.error('   - EMAIL_PASSWORD should NOT have any spaces or quotes');
            console.error('   - Make sure there are no extra characters');
            console.error('');
            console.error('✅ SOLUTION 3: For Other Email Providers:');
            console.error('   - Outlook: Use app password if 2FA is enabled');
            console.error('   - Yahoo: Requires app-specific password');
            console.error('   - Custom SMTP: Verify credentials with your provider');
            console.error('');
            console.error('✅ SOLUTION 4: Verify Environment Variables:');
            console.error('   Run this command on your server to check:');
            console.error('   echo $EMAIL_USERNAME');
            console.error('   echo $EMAIL_PASSWORD | cut -c1-4');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        } else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
            console.error('\n🌐 Connection Error - Possible solutions:');
            console.error('1. Check if EMAIL_HOST is correct');
            console.error('2. Check if EMAIL_PORT is correct (587 for TLS, 465 for SSL)');
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