const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/**
 * Generate invoice ready / inspection complete email template with inline images via ZeptoMail CID
 * @param {Object} data
 * @param {string} data.userName - Customer's first name
 * @param {string} data.orderNumber - Order tracking number
 * @param {number|string} data.finalAmount - Final total due amount
 * @param {string} data.currency - Currency symbol (default £)
 * @param {string} data.payNowLink - Payment link
 * @param {Object} data.footerOptions - Footer customization options
 * @returns {Object} - { subject, html, inlineImages }
 */
function generateInvoiceReadyTemplate(data) {
  const {
    userName = 'Customer',
    orderNumber = '',
    finalAmount = '0.00',
    currency = '£',
    payNowLink = 'https://prodlaundry.sigisolutions.net/pay',
    footerOptions = {}
  } = data;

  console.log('📸 Loading email images for invoice ready inline attachment...');
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
    <title>Inspection Complete & Invoice Ready - Just Dry Cleaners</title>
    <style>
      * { box-sizing: border-box; }
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

            <h2 style="font-size: 18px; color: #124769; margin-bottom: 20px; font-family: Arial, sans-serif; font-weight: normal;">
              Dear ${userName},
            </h2>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              We've completed the inspection of the garments you sent in Just Dry Cleaners.
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              🧺 Order ID: <strong>#${orderNumber}</strong>
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              Our team has reviewed and confirmed the final list of items. Based on the inspection, the total service amount is:
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              🧾 Total Due: <strong>${currency}${finalAmount}</strong>
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              👉 Please proceed with payment to confirm your order and begin processing:
            </p>

            <!-- Pay Now Button -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin: 10px 0 25px 0;">
              <tr>
                <td align="center">
                  <a
                    href="${payNowLink}"
                    style="
                      display: inline-block;
                      background-color: #124769;
                      color: #ffffff;
                      font-size: 16px;
                      font-weight: bold;
                      font-family: Arial, sans-serif;
                      text-decoration: none;
                      padding: 14px 50px;
                      border-radius: 30px;
                    "
                  >
                    Pay now
                  </a>
                </td>
              </tr>
            </table>

            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              If you have questions or notice any discrepancies, feel free to reach out to our support team.
            </p>

            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              Thank you for choosing Just Dry Cleaners – we'll make sure everything comes back fresh and flawless.
            </p>

            <p style="font-size: 14px; color: #000; margin-top: 10px; font-family: Arial, sans-serif; line-height: 1.8;">
              Warm regards,<br>
              Just Dry Cleaners Customer care
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
    subject: `Invoice Ready - Your Order #${orderNumber} - Just Dry Cleaners`,
    html,
    inlineImages
  };
}

module.exports = generateInvoiceReadyTemplate;
