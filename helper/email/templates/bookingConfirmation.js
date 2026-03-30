const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/**
 * Generate booking confirmation email template with inline images via ZeptoMail CID
 * @param {Object} data
 * @param {string} data.userName - Customer's first name
 * @param {string} data.email - Customer's email
 * @param {string} data.orderNumber - Order tracking number
 * @param {string} data.address - Pickup street address
 * @param {string} data.postcode - Pickup postcode
 * @param {string} data.pickupDate - Collection date (formatted)
 * @param {string} data.pickupTimeFrom - Collection time from
 * @param {string} data.pickupTimeTo - Collection time to
 * @param {string} data.dropoffDate - Delivery date (formatted)
 * @param {string} data.dropoffTimeFrom - Delivery time from
 * @param {string} data.dropoffTimeTo - Delivery time to
 * @param {number} data.upfrontAmount - Minimum order hold amount
 * @param {string} data.currency - Currency symbol (default £)
 * @param {string} data.viewBookingLink - Link to view booking
 * @param {Object} data.footerOptions - Footer customization options
 * @returns {Object} - { subject, html, inlineImages }
 */
function generateBookingConfirmationTemplate(data) {
  const {
    userName = 'Customer',
    email = '',
    orderNumber = '',
    address = '',
    postcode = '',
    pickupDate = '',
    pickupTimeFrom = '',
    pickupTimeTo = '',
    dropoffDate = '',
    dropoffTimeFrom = '',
    dropoffTimeTo = '',
    upfrontAmount = 0,
    currency = '£',
    viewBookingLink = 'https://prodlaundry.sigisolutions.net/my-bookings',
    footerOptions = {}
  } = data;

  console.log('📸 Loading email images for booking confirmation inline attachment...');
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
    <title>Booking Confirmation - Just Dry Cleaners</title>
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

            <h2 style="font-size: 18px; color: #124769; margin-bottom: 10px; font-family: Arial, sans-serif; font-weight: normal;">
              Dear ${userName},
            </h2>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 25px; font-family: Arial, sans-serif;">
              Your laundry booking has been successfully scheduled!
            </p>

            <!-- Divider -->
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 20px 0;" />

            <!-- ORDER NUMBER -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 16px;">
              <tr>
                <td align="center">
                  <p style="margin: 0 0 4px 0; font-size: 13px; color: #555; font-family: Arial, sans-serif; font-weight: bold; letter-spacing: 0.5px;">
                    ORDER NUMBER:
                  </p>
                  <p style="margin: 0; font-size: 15px; color: #000; font-family: Arial, sans-serif; font-weight: bold;">
                    ${orderNumber}
                  </p>
                </td>
              </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 16px 0;" />

            <!-- NAME -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 16px;">
              <tr>
                <td align="center">
                  <p style="margin: 0 0 4px 0; font-size: 13px; color: #555; font-family: Arial, sans-serif; font-weight: bold; letter-spacing: 0.5px;">
                    NAME:
                  </p>
                  <p style="margin: 0; font-size: 15px; color: #000; font-family: Arial, sans-serif;">
                    ${userName}
                  </p>
                </td>
              </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 16px 0;" />

            <!-- EMAIL -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 16px;">
              <tr>
                <td align="center">
                  <p style="margin: 0 0 4px 0; font-size: 13px; color: #555; font-family: Arial, sans-serif; font-weight: bold; letter-spacing: 0.5px;">
                    EMAIL:
                  </p>
                  <p style="margin: 0; font-size: 15px; font-family: Arial, sans-serif;">
                    <a href="mailto:${email}" style="color: #124769; text-decoration: none;">${email}</a>
                  </p>
                </td>
              </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 16px 0;" />

            <!-- ADDRESS -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 16px;">
              <tr>
                <td align="center">
                  <p style="margin: 0 0 4px 0; font-size: 13px; color: #555; font-family: Arial, sans-serif; font-weight: bold; letter-spacing: 0.5px;">
                    ADDRESS:
                  </p>
                  <p style="margin: 0; font-size: 15px; color: #124769; font-family: Arial, sans-serif; text-align: center; line-height: 1.5;">
                    ${address}
                  </p>
                </td>
              </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 16px 0;" />

            <!-- POSTCODE -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 16px;">
              <tr>
                <td align="center">
                  <p style="margin: 0 0 4px 0; font-size: 13px; color: #555; font-family: Arial, sans-serif; font-weight: bold; letter-spacing: 0.5px;">
                    POSTCODE:
                  </p>
                  <p style="margin: 0; font-size: 15px; color: #124769; font-family: Arial, sans-serif; font-weight: bold;">
                    ${postcode}
                  </p>
                </td>
              </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 16px 0;" />

            <!-- PICK UP DATE & TIME -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 16px;">
              <tr>
                <td align="center">
                  <p style="margin: 0 0 4px 0; font-size: 13px; color: #555; font-family: Arial, sans-serif; font-weight: bold; letter-spacing: 0.5px;">
                    PICK UP DATE &amp; TIME:
                  </p>
                  <p style="margin: 0; font-size: 15px; color: #000; font-family: Arial, sans-serif;">
                    ${pickupDate} ${pickupTimeFrom} - ${pickupTimeTo}
                  </p>
                </td>
              </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 16px 0;" />

            <!-- DROP OFF DATE & TIME -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 20px;">
              <tr>
                <td align="center">
                  <p style="margin: 0 0 4px 0; font-size: 13px; color: #555; font-family: Arial, sans-serif; font-weight: bold; letter-spacing: 0.5px;">
                    DROP OFF DATE &amp; TIME:
                  </p>
                  <p style="margin: 0; font-size: 15px; color: #000; font-family: Arial, sans-serif;">
                    ${dropoffDate} ${dropoffTimeFrom} - ${dropoffTimeTo}
                  </p>
                </td>
              </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0 0 20px 0;" />

            <!-- Minimum Order Hold -->
            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 8px; font-family: Arial, sans-serif;">
              🟡 Minimum Order Hold: <strong>${currency}${upfrontAmount}</strong>
            </p>
            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              A temporary hold has been placed on your card as a minimum order fee. This is not a charge — the final amount will be adjusted after inspection and invoicing.
            </p>

            <!-- What Happens Next -->
            <p style="font-size: 15px; color: #000; font-weight: bold; margin-bottom: 12px; font-family: Arial, sans-serif;">
              Here's what happens next:
            </p>

            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 20px;">
              <tr>
                <td style="width: 24px; vertical-align: top; padding-top: 2px;">
                  <span style="color: #28a745; font-size: 15px;">✅</span>
                </td>
                <td style="padding-left: 8px;">
                  <p style="margin: 0 0 10px 0; font-size: 14px; color: #000; line-height: 1.5; font-family: Arial, sans-serif;">
                    We'll pick up your laundry at your scheduled time.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="width: 24px; vertical-align: top; padding-top: 2px;">
                  <span style="color: #28a745; font-size: 15px;">✅</span>
                </td>
                <td style="padding-left: 8px;">
                  <p style="margin: 0 0 10px 0; font-size: 14px; color: #000; line-height: 1.5; font-family: Arial, sans-serif;">
                    Our team will inspect the items and generate an invoice.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="width: 24px; vertical-align: top; padding-top: 2px;">
                  <span style="color: #28a745; font-size: 15px;">✅</span>
                </td>
                <td style="padding-left: 8px;">
                  <p style="margin: 0 0 10px 0; font-size: 14px; color: #000; line-height: 1.5; font-family: Arial, sans-serif;">
                    Once reviewed, we'll charge the final total minus this hold.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="width: 24px; vertical-align: top; padding-top: 2px;">
                  <span style="color: #28a745; font-size: 15px;">✅</span>
                </td>
                <td style="padding-left: 8px;">
                  <p style="margin: 0 0 0 0; font-size: 14px; color: #000; line-height: 1.5; font-family: Arial, sans-serif;">
                    You'll receive real-time updates and delivery notifications.
                  </p>
                </td>
              </tr>
            </table>

            <!-- View My Booking Link -->
            <p style="margin: 20px 0 10px 0;">
              <a href="${viewBookingLink}" style="color: #dc3545; text-decoration: none; font-size: 15px; font-family: Arial, sans-serif;">
                <span style="margin-right: 5px;">📋</span><strong>[View My Booking]</strong>
              </a>
            </p>

            <!-- Contact Support Link -->
            <p style="margin: 0 0 25px 0;">
              <a href="https://prodlaundry.sigisolutions.net/support" style="color: #dc3545; text-decoration: none; font-size: 15px; font-family: Arial, sans-serif;">
                <span style="margin-right: 5px;">📞</span>[Contact Support] if you need to make changes.
              </a>
            </p>

            <!-- Sign Off -->
            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-bottom: 5px; font-family: Arial, sans-serif;">
              Thank you for trusting Just Dry Cleaners. We'll take it from here.
            </p>
            <p style="font-size: 14px; color: #000; margin-top: 10px; font-family: Arial, sans-serif; line-height: 1.6;">
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
    subject: `Booking Confirmed #${orderNumber} - Just Dry Cleaners`,
    html,
    inlineImages
  };
}

module.exports = generateBookingConfirmationTemplate;
