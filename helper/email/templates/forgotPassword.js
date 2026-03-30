const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/**
 * Generate forgot password email template with inline images via ZeptoMail CID
 * @param {Object} data
 * @param {string} data.userName - User's name
 * @param {string} data.resetLink - Password reset link
 * @param {Object} data.footerOptions - Footer customization options
 * @returns {Object} - { subject, html, inlineImages }
 */
function generateForgotPasswordTemplate(data) {
  const {
    userName = 'User',
    otp,
    footerOptions = {}
  } = data;

  console.log('📸 Loading email images for forgot password inline attachment...');
  const imagePaths = {
    logo: path.join(__dirname, '../../images/laundry Logo.png'),
    appStore: path.join(__dirname, '../../images/apple store logo.png'),
    playStore: path.join(__dirname, '../../images/play store logo.png'),
    facebook: path.join(__dirname, '../../images/facebook icon.png'),
    instagram: path.join(__dirname, '../../images/instagram icon.png'),
    tiktok: path.join(__dirname, '../../images/tiktok.png')
  };

  const inlineImages = [];

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
        content: base64Content,
        mime_type: mimeType,
        cid: cid
      });

      console.log(`   ✅ Loaded ${cid}: ${imageBuffer.length} bytes`);
    } catch (error) {
      console.error(`   ❌ Error loading ${cid}:`, error.message);
    }
  }

  console.log(`📸 Total inline images prepared: ${inlineImages.length}/6`);

  const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password - Just Dry Cleaners</title>
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

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 15px; font-family: Arial, sans-serif;">
              We received a request to reset your password.
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              Use the code below to reset your password:
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
              This code is valid for the next <strong>10 minutes</strong>. If you didn't request this, please ignore this email or contact support.
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

            <p style="font-size: 14px; color: #000; margin-top: 30px; font-family: Arial, sans-serif; line-height: 1.6;">
              Stay secure,<br>
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
    subject: 'Reset Your Password - Just Dry Cleaners',
    html,
    inlineImages
  };
}

module.exports = generateForgotPasswordTemplate;
