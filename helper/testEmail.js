const { sendEmailViaAPI, testEmailAPI } = require('./zeptomailApi');

console.log('\n🧪 Testing ZeptoMail API Configuration...\n');

// Test email using API
const testEmail = async () => {
    try {
        const result = await sendEmailViaAPI({
            from: {
                address: 'noreply@serviprapp.com',
                name: 'Laundry Cleaners'
            },
            to: 'serviprapp@gmail.com',
            subject: 'Test Email',
            html: '<div><b> Test email sent successfully via ZeptoMail API. </b></div>',
            text: 'Test email sent successfully via ZeptoMail API.'
        });

        console.log('✅ Successfully sent');
        console.log('📬 Request ID:', result.messageId);
        console.log('📧 Message:', result.data.message);
        process.exit(0);
    } catch (error) {
        console.log('❌ Error:', error.error || error.message);
        console.log('Status:', error.status);
        process.exit(1);
    }
};

// Run test
testEmail();
