const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/**
 * Generate driver arrived email template with inline images via ZeptoMail CID
 * @param {Object} data
 * @param {string} data.userName - Customer's first name
 * @param {Object} data.footerOptions - Footer customization options
 * @returns {Object} - { subject, html, inlineImages }
 */
function generateDriverArrivedTemplate(data) {
  const {
    userName = 'Customer',
    footerOptions = {}
  } = data;

  console.log('📸 Loading email images for driver arrived inline attachment...');
  const imagePaths = {
    logo: path.join(__dirname, '../../images/laundry Logo.png'),
    appStore: path.join(__dirname, '../../images/apple store logo.png'),
    playStore: path.join(__dirname, '../../images/play store logo.png'),
    facebook: path.join(__dirname, '../../images/facebook icon.png'),
    instagram: path.join(__dirname, '../../images/instagram icon.png'),
    tiktok: path.join(__dirname, '../../images/tiktok.png'),
    laundryBasket: path.join(__dirname, '../../images/Image_Laundry_Clothes.png'),
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

  console.log(`📸 Total inline images prepared: ${inlineImages.length}`);

  const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Driver Has Arrived - Just Dry Cleaners</title>
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

            <h2 style="font-size: 18px; color: #124769; margin-bottom: 20px; font-family: Arial, sans-serif; font-weight: bold;">
              HI ${userName},
            </h2>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              Your Just Dry Cleaners driver has arrived and is currently waiting outside. Please can you come and meet us as soon as possible.
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              If we don't hear from you in the next few minutes the driver will move on and we cancel this order. Please rebook in the app or on the website.
            </p>

            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 25px; font-family: Arial, sans-serif;">
              Remember you can always reschedule in our app if you know you are not going to be home.
            </p>

          </td>
        </tr>
      </table>

      <!-- Laundry Basket Image -->
      <table align="center" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 25px;">
        <tr>
          <td style="padding: 0 20px;">
            <img
              src="cid:laundryBasket"
              alt="Laundry"
              style="width: 100%; max-width: 460px; height: auto; display: block; border-radius: 4px;"
            />
          </td>
        </tr>
      </table>

      <!-- Sign Off -->
      <table align="center" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding: 0 20px;">
            <p style="font-size: 14px; color: #000; line-height: 1.8; margin: 0; font-family: Arial, sans-serif;">
              Thanks,<br>
              Just Dry Cleaners Customer care<br>
              004646450
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
    subject: 'Your Driver Has Arrived - Just Dry Cleaners',
    html,
    inlineImages
  };
}

module.exports = generateDriverArrivedTemplate;
