/**
 * Reusable email footer for all templates
 * Uses base64 embedded images for inline display
 * @param {Object} options - Footer customization options
 * @param {Object} options.imageBase64 - Object containing base64 encoded images
 * @param {string} options.imageBase64.logo - Logo base64 data URI
 * @param {string} options.imageBase64.appStore - App Store badge base64 data URI
 * @param {string} options.imageBase64.playStore - Play Store badge base64 data URI
 * @param {string} options.imageBase64.facebook - Facebook icon base64 data URI
 * @param {string} options.imageBase64.instagram - Instagram icon base64 data URI
 * @param {string} options.imageBase64.tiktok - TikTok icon base64 data URI
 * @param {string} options.helpCentreLink - Link to help center
 * @param {string} options.downloadAppLink - Link to download page
 * @param {string} options.unsubscribeLink - Unsubscribe link with token
 * @returns {string} - HTML footer with embedded images
 */
function generateFooter(options = {}) {
  const {
    imageBase64 = {},
    helpCentreLink = 'https://prodlaundry.sigisolutions.net/help',
    downloadAppLink = 'https://prodlaundry.sigisolutions.net/download',
    unsubscribeLink = 'https://prodlaundry.sigisolutions.net/unsubscribe',
  } = options;

  return `
    <!-- Footer Section -->
    <table
      align="center"
      border="0"
      cellpadding="0"
      cellspacing="0"
      role="presentation"
      style="width: 100%; max-width: 500px; margin: 0 auto; padding: 20px 0;"
      width="500"
    >
      <tbody>
        <tr>
          <td align="center">
            <!-- App Store Badges -->
            <table cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
              <tr>
                <td style="padding: 0 5px;">
                  <a href="https://apps.apple.com/your-app" target="_blank">
                    <img
                      src="${imageBase64.appStore || ''}"
                      alt="Download on App Store"
                      style="height: 40px; width: auto; display: block;"
                    />
                  </a>
                </td>
                <td style="padding: 0 5px;">
                  <a href="https://play.google.com/store/apps/your-app" target="_blank">
                    <img
                      src="${imageBase64.playStore || ''}"
                      alt="Get it on Google Play"
                      style="height: 40px; width: auto; display: block;"
                    />
                  </a>
                </td>
              </tr>
            </table>

            <!-- Logo -->
            <div style="margin: 20px 0;">
              <img
                src="${imageBase64.logo || ''}"
                alt="Just Dry Cleaners"
                style="height: 50px; width: auto; display: block; margin: 0 auto;"
              />
            </div>

            <!-- Footer Links -->
            <table cellpadding="0" cellspacing="0" style="margin: 15px 0;">
              <tr>
                <td style="padding: 0 10px;">
                  <a
                    href="${helpCentreLink}"
                    style="color: #000; text-decoration: underline; font-size: 14px; font-family: Arial, sans-serif;"
                  >
                    Help Centre
                  </a>
                </td>
                <td style="padding: 0 10px;">
                  <a
                    href="${downloadAppLink}"
                    style="color: #000; text-decoration: underline; font-size: 14px; font-family: Arial, sans-serif;"
                  >
                    Download App
                  </a>
                </td>
                <td style="padding: 0 10px;">
                  <a
                    href="${unsubscribeLink}"
                    style="color: #000; text-decoration: underline; font-size: 14px; font-family: Arial, sans-serif;"
                  >
                    Unsubscribe
                  </a>
                </td>
              </tr>
            </table>

            <!-- Social Icons -->
            <table cellpadding="0" cellspacing="0" style="margin: 15px 0;">
              <tr>
                <td style="padding: 0 8px;">
                  <a href="https://facebook.com/your-page" target="_blank">
                    <img
                      src="${imageBase64.facebook || ''}"
                      alt="Facebook"
                      style="height: 24px; width: 24px; display: block;"
                    />
                  </a>
                </td>
                <td style="padding: 0 8px;">
                  <a href="https://instagram.com/your-profile" target="_blank">
                    <img
                      src="${imageBase64.instagram || ''}"
                      alt="Instagram"
                      style="height: 24px; width: 24px; display: block;"
                    />
                  </a>
                </td>
                <td style="padding: 0 8px;">
                  <a href="https://tiktok.com/@your-profile" target="_blank">
                    <img
                      src="${imageBase64.tiktok || ''}"
                      alt="TikTok"
                      style="height: 24px; width: 24px; display: block;"
                    />
                  </a>
                </td>
              </tr>
            </table>

            <!-- Copyright -->
            <p style="font-size: 12px; color: #666; font-family: Arial, sans-serif; margin: 15px 0 0 0;">
              Just Dry Cleaners Ltd 2025
            </p>
          </td>
        </tr>
      </tbody>
    </table>
  `;
}

module.exports = generateFooter;
