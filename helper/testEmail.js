/**
 * Email Configuration Test Script
 * Run this script to test your email configuration
 * Usage: node helper/testEmail.js
 */

require('dotenv').config();
const transporter = require('./transpoter');

console.log('\n🧪 Testing Email Configuration...\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Test connection
transporter.testConnection((error, success) => {
    if (error) {
        console.error('\n❌ Email test FAILED');
        console.error('Please fix the issues above and try again.\n');
        process.exit(1);
    } else {
        console.log('\n✅ Email test PASSED');
        console.log('Your email configuration is working correctly!\n');
        
        // Optionally send a test email
        if (process.argv.includes('--send-test')) {
            console.log('📧 Sending test email...');
            transporter.sendMail({
                from: process.env.EMAIL_USERNAME,
                to: process.env.EMAIL_USERNAME, // Send to yourself
                subject: 'Test Email from Laundry App',
                text: 'This is a test email to verify your email configuration is working correctly.',
                html: '<p>This is a <strong>test email</strong> to verify your email configuration is working correctly.</p>'
            }, (error, info) => {
                if (error) {
                    console.error('❌ Failed to send test email:', error.message);
                    process.exit(1);
                } else {
                    console.log('✅ Test email sent successfully!');
                    console.log('📬 Message ID:', info.messageId);
                    console.log('Check your inbox for the test email.\n');
                    process.exit(0);
                }
            });
        } else {
            process.exit(0);
        }
    }
});

