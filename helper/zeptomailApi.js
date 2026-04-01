require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ZeptoMail API Configuration
const ZEPTOMAIL_API_URL = 'https://api.zeptomail.com/v1.1/email';
const ZEPTOMAIL_API_TOKEN = process.env.ZEPTOMAIL_API_TOKEN
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
const FROM_NAME = process.env.FROM_NAME || 'Laundry Cleaners';

// Log token status (without exposing full token)
console.log('🔐 ZeptoMail API Configuration:');
console.log('   API URL:', ZEPTOMAIL_API_URL);
console.log('   Token Set:', ZEPTOMAIL_API_TOKEN ? 'YES' : 'NO');
console.log('   Token Source:', process.env.ZEPTOMAIL_API_TOKEN ? 'Environment Variable' : 'Hardcoded Fallback');
console.log('   Token Prefix:', ZEPTOMAIL_API_TOKEN ? (ZEPTOMAIL_API_TOKEN.startsWith('Zoho-enczapikey ') ? '✅ Correct' : '❌ Missing prefix') : 'N/A');
console.log('   Token Length:', ZEPTOMAIL_API_TOKEN ? ZEPTOMAIL_API_TOKEN.length : 0);
console.log('   From Email:', FROM_EMAIL);
console.log('   From Name:', FROM_NAME);
console.log('');

/**
 * Parse email address string to extract name and email
 * Handles formats: "email@domain.com" or "Name <email@domain.com>"
 * @param {string} emailString - Email string to parse
 * @returns {Object} - { address: string, name: string }
 */
function parseEmailAddress(emailString) {
    if (typeof emailString !== 'string') {
        return emailString; // Already an object
    }
    
    const match = emailString.match(/^(.+?)\s*<(.+?)>$/) || [null, null, emailString];
    return {
        address: match[2] || emailString.trim(),
        name: match[1] ? match[1].trim().replace(/^["']|["']$/g, '') : emailString.split('@')[0]
    };
}

/**
 * Read file and convert to base64 for attachment
 * @param {string} filePath - Path to the file
 * @returns {Promise<Object>} - { content: base64, filename: string, content_type: string }
 */
async function prepareAttachment(filePath) {
    try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
        
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${fullPath}`);
        }

        const fileContent = fs.readFileSync(fullPath);
        const base64Content = fileContent.toString('base64');
        const filename = path.basename(fullPath);
        
        // Determine content type from extension
        const ext = path.extname(filename).toLowerCase();
        const contentTypes = {
            '.pdf': 'application/pdf',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.txt': 'text/plain',
            '.csv': 'text/csv',
            '.zip': 'application/zip'
        };
        
        const content_type = contentTypes[ext] || 'application/octet-stream';

        return {
            content: base64Content,
            filename: filename,
            content_type: content_type
        };
    } catch (error) {
        console.error(`Error preparing attachment ${filePath}:`, error.message);
        throw error;
    }
}

/**
 * Send email using ZeptoMail API
 * @param {Object} options - Email options
 * @param {string|Array} options.to - Recipient email(s) - can be string, array of strings, or array of objects
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} [options.text] - Plain text content (optional)
 * @param {string|Object} [options.from] - From email (optional, uses default if not provided)
 * @param {string} [options.fromName] - From name (optional)
 * @param {string|Array} [options.cc] - CC recipients (optional)
 * @param {string|Array} [options.bcc] - BCC recipients (optional)
 * @param {string|Array} [options.replyTo] - Reply-to address(es) (optional)
 * @param {Array} [options.attachments] - Array of attachment file paths or objects (optional)
 * @param {Array} [options.inlineImages] - Array of inline images with {content, mime_type, cid} (optional)
 * @param {Object} [options.headers] - Custom headers (optional)
 * @param {Object} [options.trackOpens] - Track email opens (optional, default: false)
 * @param {Object} [options.trackClicks] - Track email clicks (optional, default: false)
 * @returns {Promise<Object>} - API response with success status and messageId
 */
async function sendEmailViaAPI({
    to,
    subject,
    html,
    text,
    from,
    fromName,
    cc,
    bcc,
    replyTo,
    attachments,
    inlineImages,
    headers,
    trackOpens = false,
    trackClicks = false
}) {
    try {
        // Validate required fields
        if (!to) {
            throw new Error('Recipient email (to) is required');
        }
        if (!subject) {
            throw new Error('Email subject is required');
        }
        if (!html && !text) {
            throw new Error('Email content (html or text) is required');
        }

        // Parse 'from' address
        const fromAddress = from ? parseEmailAddress(from) : {
            address: FROM_EMAIL,
            name: fromName || FROM_NAME
        };

        // Normalize 'to' to array and parse
        const toArray = Array.isArray(to) ? to : [to];
        const recipients = toArray.map(email => ({
            email_address: parseEmailAddress(email)
        }));

        // Build payload
        const payload = {
            from: fromAddress,
            to: recipients,
            subject: subject
        };

        // Add HTML body
        if (html) {
            payload.htmlbody = html;
        }

        // Add text body
        if (text) {
            payload.textbody = text;
        }

        // Add CC if provided
        if (cc) {
            const ccArray = Array.isArray(cc) ? cc : [cc];
            payload.cc = ccArray.map(email => ({
                email_address: parseEmailAddress(email)
            }));
        }

        // Add BCC if provided
        if (bcc) {
            const bccArray = Array.isArray(bcc) ? bcc : [bcc];
            payload.bcc = bccArray.map(email => ({
                email_address: parseEmailAddress(email)
            }));
        }

        // Add Reply-To if provided
        if (replyTo) {
            const replyToArray = Array.isArray(replyTo) ? replyTo : [replyTo];
            payload.reply_to = replyToArray.map(email => parseEmailAddress(email));
        }

        // Add inline images if provided (for CID references in HTML)
        if (inlineImages && inlineImages.length > 0) {
            payload.inline_images = [];
            
            for (const image of inlineImages) {
                if (typeof image === 'string') {
                    // File path provided
                    const img = await prepareAttachment(image);
                    payload.inline_images.push({
                        content: img.content,
                        mime_type: img.content_type,
                        cid: path.basename(image, path.extname(image)) // Use filename as CID
                    });
                } else if (image.content && image.cid) {
                    // Already prepared inline image object
                    payload.inline_images.push({
                        content: image.content, // base64 encoded
                        mime_type: image.mime_type || image.content_type || 'image/png',
                        cid: image.cid
                    });
                } else if (image.path && image.cid) {
                    // File path with CID
                    const img = await prepareAttachment(image.path);
                    payload.inline_images.push({
                        content: img.content,
                        mime_type: img.content_type,
                        cid: image.cid
                    });
                }
            }
            console.log(`📎 Added ${payload.inline_images.length} inline images`);
        }

        // Add attachments if provided
        if (attachments && attachments.length > 0) {
            payload.attachments = [];
            
            for (const attachment of attachments) {
                if (typeof attachment === 'string') {
                    // File path provided
                    const att = await prepareAttachment(attachment);
                    payload.attachments.push(att);
                } else if (attachment.content) {
                    // Already prepared attachment object
                    payload.attachments.push({
                        content: attachment.content, // base64 encoded
                        filename: attachment.filename,
                        content_type: attachment.content_type || 'application/octet-stream'
                    });
                } else if (attachment.path) {
                    // File path in object
                    const att = await prepareAttachment(attachment.path);
                    payload.attachments.push({
                        ...att,
                        filename: attachment.filename || att.filename,
                        content_type: attachment.content_type || att.content_type
                    });
                }
            }
        }

        // Add custom headers if provided
        if (headers && Object.keys(headers).length > 0) {
            payload.headers = headers;
        }

        // Add tracking options
        if (trackOpens) {
            payload.track_opens = true;
        }
        if (trackClicks) {
            payload.track_clicks = true;
        }

        // Validate token before making request
        if (!ZEPTOMAIL_API_TOKEN) {
            throw new Error('ZeptoMail API token is not configured. Please set ZEPTOMAIL_API_TOKEN in your .env file.');
        }

        if (!ZEPTOMAIL_API_TOKEN.startsWith('Zoho-enczapikey ')) {
            console.warn('⚠️  Warning: API token should start with "Zoho-enczapikey "');
        }

        // Log request details (without sensitive data)
        console.log('📤 Sending email via ZeptoMail API...');
        console.log('   To:', Array.isArray(to) ? to.join(', ') : to);
        console.log('   Subject:', subject);
        console.log('   From:', payload.from.address);

        // Make API request
        const response = await axios.post(ZEPTOMAIL_API_URL, payload, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': ZEPTOMAIL_API_TOKEN
            },
            timeout: 30000 // 30 seconds timeout for attachments
        });

        console.log('✅ Email sent via ZeptoMail API successfully');
        console.log('📬 Request ID:', response.data.request_id);
        console.log('📧 Message:', response.data.message);

        return {
            success: true,
            messageId: response.data.request_id,
            data: response.data
        };
    } catch (error) {
        console.error('❌ Error sending email via ZeptoMail API:');
        console.error('   Error:', error.response?.data || error.message);
        console.error('   Status:', error.response?.status);
        console.error('   Status Text:', error.response?.statusText);
        
        // Detailed error information
        if (error.response?.data) {
            const errorData = error.response.data;
            console.error('   Error Code:', errorData.code || errorData.error?.code || 'N/A');
            console.error('   Error Message:', errorData.message || errorData.error?.message || 'N/A');
            if (errorData.details || errorData.error?.details) {
                console.error('   Error Details:', JSON.stringify(errorData.details || errorData.error?.details, null, 2));
            }
            if (errorData.error) {
                console.error('   Full Error Object:', JSON.stringify(errorData.error, null, 2));
            }
        }

        // Specific error handling for 401
        if (error.response?.status === 401) {
            console.error('\n🔐 Authentication Error (401 - Access Denied):');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('The ZeptoMail API token is invalid or expired.');
            console.error('');
            console.error('✅ Solutions:');
            console.error('1. Check your .env file has ZEPTOMAIL_API_TOKEN set');
            console.error('2. Verify the token is correct in ZeptoMail dashboard');
            console.error('3. Ensure the token starts with "Zoho-enczapikey "');
            console.error('4. Get a new token from: https://zeptomail.zoho.com');
            console.error('   → Go to: Mail Agent → Setup Details → API');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        const errorData = error.response?.data || {};
        const errorObj = errorData.error || errorData;
        
        throw {
            success: false,
            error: errorObj,
            status: error.response?.status,
            statusText: error.response?.statusText,
            details: errorObj.details || errorData.details,
            code: errorObj.code || errorData.code,
            message: errorObj.message || errorData.message
        };
    }
}

/**
 * Test email sending (simple test function)
 * @param {string} testEmail - Email address to send test to
 * @returns {Promise<Object>} - Result of test email
 */
async function testEmailAPI(testEmail) {
    try {
        const result = await sendEmailViaAPI({
            to: testEmail,
            subject: 'Test Email from Laundry App',
            html: '<div><b>Test email sent successfully via ZeptoMail API.</b></div>',
            text: 'Test email sent successfully via ZeptoMail API.'
        });
        return result;
    } catch (error) {
        throw error;
    }
}

/**
 * Validate ZeptoMail API token configuration
 * @returns {Object} - Validation result
 */
function validateTokenConfig() {
    const issues = [];
    const warnings = [];

    if (!ZEPTOMAIL_API_TOKEN) {
        issues.push('ZEPTOMAIL_API_TOKEN is not set');
    } else {
        if (!ZEPTOMAIL_API_TOKEN.startsWith('Zoho-enczapikey ')) {
            issues.push('Token must start with "Zoho-enczapikey "');
        }
        if (ZEPTOMAIL_API_TOKEN.length < 50) {
            warnings.push('Token seems too short (might be incomplete)');
        }
    }

    if (!process.env.ZEPTOMAIL_API_TOKEN) {
        warnings.push('Using hardcoded fallback token - set ZEPTOMAIL_API_TOKEN in .env file');
    }

    return {
        valid: issues.length === 0,
        issues,
        warnings,
        tokenSet: !!ZEPTOMAIL_API_TOKEN,
        tokenFromEnv: !!process.env.ZEPTOMAIL_API_TOKEN
    };
}

module.exports = {
    sendEmailViaAPI,
    testEmailAPI,
    parseEmailAddress,
    prepareAttachment,
    validateTokenConfig
};

// Validate token on module load
const tokenValidation = validateTokenConfig();
if (!tokenValidation.valid) {
    console.error('❌ ZeptoMail API Token Configuration Issues:');
    tokenValidation.issues.forEach(issue => console.error('   -', issue));
}
if (tokenValidation.warnings.length > 0) {
    console.warn('⚠️  ZeptoMail API Token Warnings:');
    tokenValidation.warnings.forEach(warning => console.warn('   -', warning));
}

