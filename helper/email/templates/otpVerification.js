const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/**
 * Generate OTP verification email template with base64 embedded images
 * @param {Object} data
 * @param {string} data.userName - User's name
 * @param {string} data.otp - OTP code
 * @param {string} data.type - Template type ('RegisterOTP' or 'ForgetPassword')
 * @param {Object} data.footerOptions - Footer customization options
 * @returns {Object} - { subject, html }
 */
function generateOtpTemplate(data) {
  const {
    userName = 'User',
    otp,
    type = 'RegisterOTP',
    footerOptions = {}
  } = data;

  // Prepare inline images for ZeptoMail API (using CID references)
  console.log('📸 Loading email images for inline attachment...');
  const imagePaths = {
    logo: path.join(__dirname, '../../images/laundry Logo.png'),
    appStore: path.join(__dirname, '../../images/apple store logo.png'),
    playStore: path.join(__dirname, '../../images/play store logo.png'),
    facebook: path.join(__dirname, '../../images/facebook icon.png'),
    instagram: path.join(__dirname, '../../images/instagram icon.png'),
    tiktok: path.join(__dirname, '../../images/tiktok.png')
  };

  const inlineImages = [];
  
  // Load each image and prepare for ZeptoMail inline_images array
  for (const [cid, filePath] of Object.entries(imagePaths)) {
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`   ❌ File not found: ${filePath}`);
        continue;
      }
      const imageBuffer = fs.readFileSync(filePath);
      const base64Content = imageBuffer.toString('base64');
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      
      inlineImages.push({
        content: base64Content,  // Plain base64, not data URI
        mime_type: mimeType,
        cid: cid  // Will be referenced as cid:logo, cid:facebook, etc.
      });
      
      console.log(`   ✅ Loaded ${cid}: ${imageBuffer.length} bytes`);
    } catch (error) {
      console.error(`   ❌ Error loading ${cid}:`, error.message);
    }
  }
  
  console.log(`📸 Total inline images prepared: ${inlineImages.length}/6`);

  const isRegistration = type === 'RegisterOTP';
  const title = isRegistration ? 'OTP for Registration' : 'OTP for Password Reset';
  const purpose = isRegistration ? 'verify your registration' : 'reset your password';

  const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 0;
        background-color: #f4f4f4;
        font-family: Arial, sans-serif;
      }
      .email-container {
        max-width: 500px;
        margin: 20px auto;
        background-color: #ffffff;
        padding: 30px 20px;
      }
      @media (max-width: 520px) {
        .email-container {
          width: 100% !important;
          padding: 20px 15px !important;
        }
        .otp-table td {
          padding: 0 2px !important;
        }
        .otp-digit {
          padding: 12px 16px !important;
          font-size: 20px !important;
        }
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <!-- Logo -->
      <table align="center" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 30px;">
        <tr>
          <td align="center">
            <img
                  src="cid:logo"
                  alt="Just Dry Cleaners"
              style="height: 60px; width: auto; display: block; margin: 0 auto;"
            />
          </td>
        </tr>
      </table>

      <!-- Main Content -->
      <table align="center" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding: 0 20px;">
            <h2 style="font-size: 18px; color: #000; margin-bottom: 20px; font-family: Arial, sans-serif; font-weight: normal;">
              Hi ${userName},
            </h2>
            
            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif; text-align: left;">
              Your one-time verification code is:
            </p>

            <!-- OTP Display -->
            <div style="text-align: center; margin: 30px 0;">
              <div style="
                display: inline-block;
                background-color: #124769;
                padding: 20px 40px;
                border-radius: 8px;
                font-size: 32px;
                font-weight: bold;
                font-family: monospace;
                color: #fff;
                letter-spacing: 8px;
                user-select: all;
                -webkit-user-select: all;
                -moz-user-select: all;
                -ms-user-select: all;
              ">
                ${otp}
              </div>
            </div>

            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-bottom: 15px; font-family: Arial, sans-serif;">
              This code is valid for the next <strong>10 minutes</strong> and can be used to ${purpose} on Just Dry Cleaners.
            </p>

            <!-- Warning Box -->
            <div style="
              background-color: #fff3cd;
              border-left: 4px solid #ffc107;
              padding: 12px 16px;
              margin: 20px 0;
              border-radius: 4px;
            ">
              <p style="margin: 0; font-size: 14px; color: #856404; font-family: Arial, sans-serif;">
                ⚠️ Do not share this code with anyone. We will never ask you for your OTP.
              </p>
            </div>

            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-top: 20px; font-family: Arial, sans-serif;">
              If you did not request this code, please ignore this email or contact our support team immediately.
            </p>

            <p style="font-size: 14px; color: #000; margin-top: 30px; font-family: Arial, sans-serif; line-height: 1.6;">
              Thank you,<br>
              Just Dry Cleaners customer support
            </p>
          </td>
        </tr>
      </table>

      ${generateFooter(footerOptions)}
    </div>
  </body>
</html>
  `;

  return {
    subject: `${title} - Just Dry Cleaners`,
    html,
    inlineImages  // Return inline images for ZeptoMail API
  };
}

module.exports = generateOtpTemplate;
