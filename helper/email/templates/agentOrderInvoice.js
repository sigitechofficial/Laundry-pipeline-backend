const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/**
 * Generate agent order invoice email template (sent to shop agent when invoice is finalized)
 * @param {Object} data
 * @param {string} data.agentName - Agent's first name
 * @param {string} data.shopName - Laundry shop name
 * @param {string} data.orderNumber - Order tracking number
 * @param {string} data.customerName - Customer's name
 * @param {number|string} data.finalAmount - Final invoice total
 * @param {string} data.currency - Currency symbol (default £)
 * @param {string} data.viewOrderLink - Link to view order in agent panel
 * @param {Object} data.footerOptions - Footer customization options
 * @returns {Object} - { subject, html, inlineImages }
 */
function generateAgentOrderInvoiceTemplate(data) {
  const {
    agentName = 'Agent',
    shopName = 'Your shop',
    orderNumber = '',
    customerName = 'Customer',
    finalAmount = '0.00',
    currency = '£',
    viewOrderLink = 'https://prodlaundry.sigisolutions.net/agent/orders',
    footerOptions = {}
  } = data;

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
      if (!fs.existsSync(filePath)) continue;
      const imageBuffer = fs.readFileSync(filePath);
      const base64Content = imageBuffer.toString('base64');
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

      inlineImages.push({
        content: base64Content,
        mime_type: mimeType,
        cid: cid
      });
    } catch (error) {
      console.error(`   ❌ Error loading ${cid}:`, error.message);
    }
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Invoice Finalized - Just Dry Cleaners</title>
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

      <table align="center" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding: 0 20px;">

            <h2 style="font-size: 18px; color: #124769; margin-bottom: 20px; font-family: Arial, sans-serif; font-weight: normal;">
              Dear ${agentName},
            </h2>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              The invoice for an order at <strong>${shopName}</strong> has been finalized and sent to the customer.
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 12px; font-family: Arial, sans-serif;">
              🧺 Order ID: <strong>#${orderNumber}</strong>
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 12px; font-family: Arial, sans-serif;">
              👤 Customer: <strong>${customerName}</strong>
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              🧾 Invoice total: <strong>${currency}${finalAmount}</strong>
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              The customer has been notified to complete payment. You can review the order details in your agent dashboard.
            </p>

            <table cellpadding="0" cellspacing="0" width="100%" style="margin: 10px 0 25px 0;">
              <tr>
                <td align="center">
                  <a
                    href="${viewOrderLink}"
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
                    View order
                  </a>
                </td>
              </tr>
            </table>

            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              If anything looks incorrect, please update the invoice before the customer pays.
            </p>

            <p style="font-size: 14px; color: #000; margin-top: 10px; font-family: Arial, sans-serif; line-height: 1.8;">
              Warm regards,<br>
              Just Dry Cleaners Team
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
    subject: `Invoice Finalized - Order #${orderNumber} - ${shopName}`,
    html,
    inlineImages
  };
}

module.exports = generateAgentOrderInvoiceTemplate;
