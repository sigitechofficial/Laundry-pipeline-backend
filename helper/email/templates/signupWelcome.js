const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/**
 * Generate signup welcome email template
 * @param {Object} data - Template data
 * @param {string} data.userName - User's name
 * @param {string} [data.bookOrderLink] - Link to book first order
 * @param {Object} [data.footerOptions] - Footer customization options
 * @returns {Object} - { subject, html, inlineImages }
 */
function generateSignupWelcomeTemplate(data) {
  const {
    userName = 'User',
    bookOrderLink = 'https://prodlaundry.sigisolutions.net/book-order',
    footerOptions = {}
  } = data;

  // Prepare inline images for ZeptoMail API (using CID references)
  console.log('📸 Loading welcome email images for inline attachment...');
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
    <title>Welcome to Just Dry Cleaners</title>
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      body {
        font-family: Arial, sans-serif;
        background-color: #f4f4f4;
        padding: 20px;
      }
      .email-container {
        max-width: 600px;
        margin: 0 auto;
        background-color: #ffffff;
        padding: 40px 30px;
        border-radius: 8px;
      }
      .logo-container {
        text-align: center;
        margin-bottom: 30px;
      }
      .logo-container img {
        height: 60px;
        width: auto;
      }
      h1 {
        color: #124769;
        font-size: 18px;
        margin-bottom: 20px;
      }
      p {
        color: #333;
        font-size: 15px;
        line-height: 1.6;
        margin-bottom: 15px;
      }
      .features-title {
        color: #333;
        font-size: 16px;
        font-weight: bold;
        margin: 25px 0 15px 0;
      }
      .feature-item {
        display: flex;
        align-items: flex-start;
        margin-bottom: 12px;
      }
      .checkmark {
        color: #28a745;
        font-size: 18px;
        font-weight: bold;
        margin-right: 10px;
        flex-shrink: 0;
      }
      .feature-text {
        color: #333;
        font-size: 15px;
        line-height: 1.5;
      }
      .cta-button {
        display: inline-block;
        margin: 25px 0;
        padding: 12px 24px;
        background-color: transparent;
        color: #dc3545;
        text-decoration: none;
        border-radius: 4px;
        font-size: 15px;
        font-weight: normal;
      }
      .cta-emoji {
        margin-right: 5px;
      }
      .signature {
        margin-top: 30px;
        color: #333;
        font-size: 15px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px;" width="600">
      <tbody>
        <tr>
          <td style="padding: 40px 30px;">
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
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td style="padding: 0 20px;">
                    <h1 style="color: #000; font-size: 18px; margin-bottom: 20px; font-weight: normal; font-family: Arial, sans-serif;">Hi ${userName},</h1>
                    
                    <p style="color: #000; font-size: 15px; line-height: 1.6; margin-bottom: 15px; font-family: Arial, sans-serif;">
                      Thanks for joining Just Dry Cleaners – where fresh, clean clothes are just a tap away.
                    </p>

                    <p class="features-title" style="color: #000; font-size: 16px; font-weight: bold; margin: 25px 0 15px 0; font-family: Arial, sans-serif;">
                      Here's what you can do:
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Features List -->
              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 20px;">
                <tr>
                  <td style="padding: 0 20px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 12px;">
                      <tr>
                        <td style="width: 20px; vertical-align: top; padding-top: 2px;">
                          <span style="color: #28a745; font-size: 16px; font-weight: bold;">✅</span>
                        </td>
                        <td style="padding-left: 10px;">
                          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.5;">
                            Schedule pick-ups and deliveries at your convenience
                          </p>
                        </td>
                      </tr>
                    </table>
                    
                    <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 12px;">
                      <tr>
                        <td style="width: 20px; vertical-align: top; padding-top: 2px;">
                          <span style="color: #28a745; font-size: 16px; font-weight: bold;">✅</span>
                        </td>
                        <td style="padding-left: 10px;">
                          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.5;">
                            Choose from premium dry cleaning, wash & fold, ironing, and more
                          </p>
                        </td>
                      </tr>
                    </table>
                    
                    <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 12px;">
                      <tr>
                        <td style="width: 20px; vertical-align: top; padding-top: 2px;">
                          <span style="color: #28a745; font-size: 16px; font-weight: bold;">✅</span>
                        </td>
                        <td style="padding-left: 10px;">
                          <p style="margin: 0; color: #000; font-size: 15px; line-height: 1.5; font-family: Arial, sans-serif;">
                            Track your orders in real-time
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td style="padding: 0 20px;">
                    <p style="margin: 25px 0;">
                      <a href="${bookOrderLink}" style="color: #dc3545; text-decoration: none; font-size: 15px; font-family: Arial, sans-serif;">
                        <span style="margin-right: 5px;">👉</span><strong>[Book Your First Order Now]</strong>
                      </a>
                    </p>

                    <!-- Support Message -->
                    <p style="color: #000; font-size: 15px; line-height: 1.6; margin-top: 25px; font-family: Arial, sans-serif;">
                      Need help? Our support team is just a message away.
                    </p>

                    <!-- Signature -->
                    <p style="color: #000; font-size: 15px; line-height: 1.6; margin-top: 30px; font-family: Arial, sans-serif;">
                      Warm regards,<br>
                      Just Dry Cleaners customer support
                    </p>
                  </td>
                </tr>
              </table>

              ${generateFooter(footerOptions)}
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>
  `;

  return {
    subject: 'Welcome to Just Dry Cleaners! 🎉',
    html,
    inlineImages
  };
}

module.exports = generateSignupWelcomeTemplate;
