require('dotenv').config();
const { validateTokenConfig } = require('./zeptomailApi');

console.log('\n🔍 ZeptoMail API Token Diagnostic\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const validation = validateTokenConfig();

console.log('\n📋 Configuration Status:');
console.log('   Token Set:', validation.tokenSet ? '✅ YES' : '❌ NO');
console.log('   Token from .env:', validation.tokenFromEnv ? '✅ YES' : '❌ NO (using fallback)');
console.log('   Valid:', validation.valid ? '✅ YES' : '❌ NO');

if (validation.issues.length > 0) {
    console.log('\n❌ Issues Found:');
    validation.issues.forEach(issue => {
        console.log('   -', issue);
    });
}

if (validation.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    validation.warnings.forEach(warning => {
        console.log('   -', warning);
    });
}

console.log('\n📝 How to Fix:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('1. Go to: https://zeptomail.zoho.com');
console.log('2. Navigate to: Mail Agent → Setup Details → API');
console.log('3. Copy your API token');
console.log('4. Add to your .env file:');
console.log('   ZEPTOMAIL_API_TOKEN=Zoho-enczapikey YOUR_TOKEN_HERE');
console.log('5. Make sure the token starts with "Zoho-enczapikey "');
console.log('6. Restart your server');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exit(validation.valid ? 0 : 1);

