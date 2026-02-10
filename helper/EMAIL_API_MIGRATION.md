# Email System Migration: SMTP to ZeptoMail API

## Overview
The email system has been migrated from SMTP (Nodemailer) to ZeptoMail API for better reliability, especially on cPanel servers.

## Changes Made

### 1. New API Helper (`helper/zeptomailApi.js`)
- Complete ZeptoMail API integration
- Supports all email features:
  - ✅ HTML and plain text emails
  - ✅ Multiple recipients (to, cc, bcc)
  - ✅ Attachments (file paths or base64)
  - ✅ Custom headers
  - ✅ Reply-to addresses
  - ✅ Email tracking (opens, clicks)

### 2. Updated Email Functions
- `helper/otpMail.js` - Now uses API instead of SMTP
- All `otpMail()` calls updated to use `await` (function is now async)
- `helper/testEmail.js` - Updated to use API

### 3. Files Updated
- ✅ `helper/otpMail.js` - Main OTP email function
- ✅ `helper/testEmail.js` - Test email script
- ✅ `services/Agent/authService.js` - All otpMail calls
- ✅ `controllers/Agent/agentAuth.js` - All otpMail calls
- ✅ `services/Customer/authService.js` - All otpMail calls
- ✅ `controllers/Driver/driverAuth.js` - All otpMail calls
- ✅ `controllers/Customer/customerOrders.js` - Test email endpoint

## Environment Variables

Add these to your `.env` file:

```env
# ZeptoMail API Configuration
ZEPTOMAIL_API_TOKEN=Zoho-enczapikey wSsVR612/0WiW6Z7yDL4cuppng5dBVOjFUV93gel63L9Fv3FpcdpwxDIUQ+gGPUbFW9oQjoXrO8qnR8H1zNY2o5/yA0DXCiF9mqRe1U4J3x17qnvhDzPW2xVlxOBLY4Mxw5smGdoFsAr+g==

# Email Sender Configuration
FROM_EMAIL=noreply@serviprapp.com
FROM_NAME=Trim
EMAIL_USERNAME="Trim" <noreply@serviprapp.com>
```

## Usage Examples

### Basic Email
```javascript
const { sendEmailViaAPI } = require('./helper/zeptomailApi');

await sendEmailViaAPI({
    to: 'user@example.com',
    subject: 'Test Email',
    html: '<h1>Hello World</h1>',
    text: 'Hello World'
});
```

### Email with Attachments
```javascript
await sendEmailViaAPI({
    to: 'user@example.com',
    subject: 'Invoice',
    html: '<p>Please find attached invoice.</p>',
    attachments: [
        '/path/to/invoice.pdf',
        {
            content: base64String,
            filename: 'document.pdf',
            content_type: 'application/pdf'
        }
    ]
});
```

### Email with CC/BCC
```javascript
await sendEmailViaAPI({
    to: 'user@example.com',
    cc: ['manager@example.com'],
    bcc: ['archive@example.com'],
    subject: 'Report',
    html: '<p>Monthly report attached.</p>',
    attachments: ['/path/to/report.pdf']
});
```

### Email with Custom Headers
```javascript
await sendEmailViaAPI({
    to: 'user@example.com',
    subject: 'Custom Email',
    html: '<p>Email with custom headers.</p>',
    headers: {
        'X-Custom-Header': 'value',
        'X-Priority': '1'
    }
});
```

## Benefits

1. **No SSL/TLS Issues** - API uses HTTPS, no certificate problems
2. **Works on cPanel** - No port restrictions or firewall issues
3. **More Reliable** - HTTP API is more stable than SMTP
4. **Better Error Handling** - Clear API error responses
5. **Future-Proof** - Easy to add features like attachments, tracking, etc.

## Testing

Run the test email script:
```bash
node helper/testEmail.js
```

Or use the API endpoint:
```bash
POST http://localhost:3010/customer/testEmail
Body: {
    "email": "your-email@example.com",
    "type": "RegisterOTP"
}
```

## Migration Notes

- The old `transpoter.js` file is still present but no longer used
- All email sending now goes through the ZeptoMail API
- The `otpMail` function signature remains the same, but it's now async
- All callers have been updated to use `await otpMail(...)`

## Troubleshooting

### Error: "Invalid API token"
- Check `ZEPTOMAIL_API_TOKEN` in `.env`
- Ensure the token includes the "Zoho-enczapikey " prefix

### Error: "Sender not verified"
- Verify `noreply@serviprapp.com` is verified in ZeptoMail dashboard
- Or update `FROM_EMAIL` to a verified sender

### Error: "Request timeout"
- Check internet connection
- Verify ZeptoMail API is accessible
- Increase timeout in `zeptomailApi.js` if needed

