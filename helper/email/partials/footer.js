/**
 * Reusable email footer for all templates
 * Uses CID (Content-ID) references for inline images via ZeptoMail API
 * @param {Object} options - Footer customization options
 * @param {string} options.helpCentreLink - Link to help center
 * @param {string} options.downloadAppLink - Link to download page
 * @param {string} options.unsubscribeLink - Unsubscribe link with token
 * @returns {string} - HTML footer with CID image references
 * 
 * Image CIDs used: logo, appStore, playStore, facebook, instagram, tiktok
 */
function generateFooter(options = {}) {
  const {
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
            <table cellpadding="0" cellspacing="0" style="margin: 0 auto 20px auto; border-collapse: collapse;">
              <tr>
                <td style="padding: 0 4px;">
                  <a href="https://apps.apple.com/your-app" target="_blank" style="display: inline-block; line-height: 0;">
                    <img
                      src="cid:appStore"
                      alt="Download on App Store"
                      style="height: 38px; width: auto; display: block; border: 0;"
                    />
                  </a>
                </td>
                <td style="padding: 0 4px;">
                  <a href="https://play.google.com/store/apps/your-app" target="_blank" style="display: inline-block; line-height: 0;">
                    <img
                      src="cid:playStore"
                      alt="Get it on Google Play"
                      style="height: 38px; width: auto; display: block; border: 0;"
                    />
                  </a>
                </td>
              </tr>
            </table>

            <!-- Logo -->
            <div style="margin: 20px 0;">
              <img
                src="cid:logo"
                alt="Just Dry Cleaners"
                style="height: 50px; width: auto; display: block; margin: 0 auto;"
              />
            </div>

            <!-- Footer Links -->
            <table cellpadding="0" cellspacing="0" style="margin: 15px auto; border-collapse: collapse;">
              <tr>
                <td style="padding: 0 5px; white-space: nowrap;">
                  <a
                    href="${helpCentreLink}"
                    style="color: #000; text-decoration: underline; font-size: 12px; font-family: Arial, sans-serif; white-space: nowrap;"
                  >
                    Help Centre
                  </a>
                </td>
                <td style="padding: 0 5px; white-space: nowrap;">
                  <a
                    href="${downloadAppLink}"
                    style="color: #000; text-decoration: underline; font-size: 12px; font-family: Arial, sans-serif; white-space: nowrap;"
                  >
                    Download App
                  </a>
                </td>
                <td style="padding: 0 5px; white-space: nowrap;">
                  <a
                    href="${unsubscribeLink}"
                    style="color: #000; text-decoration: underline; font-size: 12px; font-family: Arial, sans-serif; white-space: nowrap;"
                  >
                    Unsubscribe
                  </a>
                </td>
              </tr>
            </table>

            <!-- Social Icons -->
            <table cellpadding="0" cellspacing="0" style="margin: 15px auto; border-collapse: collapse;">
              <tr>
                <td style="padding: 0 6px;">
                  <a href="https://facebook.com/your-page" target="_blank" style="display: inline-block; line-height: 0;">
                    <img
                      src="cid:facebook"
                      alt="Facebook"
                      style="height: 24px; width: 24px; display: block; border: 0;"
                    />
                  </a>
                </td>
                <td style="padding: 0 6px;">
                  <a href="https://instagram.com/your-profile" target="_blank" style="display: inline-block; line-height: 0;">
                    <img
                      src="cid:instagram"
                      alt="Instagram"
                      style="height: 24px; width: 24px; display: block; border: 0;"
                    />
                  </a>
                </td>
                <td style="padding: 0 6px;">
                  <a href="https://tiktok.com/@your-profile" target="_blank" style="display: inline-block; line-height: 0;">
                    <img
                      src="cid:tiktok"
                      alt="TikTok"
                      style="height: 24px; width: 24px; display: block; border: 0;"
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
