const generateFooter = require('../partials/footer');
const fs = require('fs');
const path = require('path');

/** Photos bigger than this are left out of the email (the app still shows them). */
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;
const MAX_PHOTOS = 6;

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function loadImage(filePath, cid) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PHOTO_BYTES) return null;
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { content: fs.readFileSync(filePath).toString('base64'), mime_type: mimeType, cid };
  } catch (error) {
    console.error(`   ❌ Error loading ${cid}:`, error.message);
    return null;
  }
}

/**
 * Items on hold: tells the customer which item, what the shop found and asks
 * them to answer in the app.
 * @param {Object} data
 * @param {string} data.userName
 * @param {string} data.orderNumber
 * @param {Array<{serviceName, itemName, pieces, risk, shopNote, photo}>} data.items
 * @param {string} [data.photoRoot] - folder the saved photo paths are relative to
 * @returns {{subject: string, html: string, inlineImages: Array}}
 */
/**
 * Shop registration not approved: tells the shop owner why and what to do next.
 * @param {Object} data
 * @param {string} data.userName
 * @param {string|null} data.shopName
 * @param {string[]} data.reasons - picked by admin from the fixed list
 * @param {string|null} data.note - admin's own words
 */
function generateAgentRejectedTemplate(data) {
  const { userName = 'there', shopName = null, reasons = [], note = null, footerOptions = {} } = data;
  const inlineImages = [];
  const brand = {
    logo: path.join(__dirname, '../../images/laundry Logo.png'),
    appStore: path.join(__dirname, '../../images/apple store logo.png'),
    playStore: path.join(__dirname, '../../images/play store logo.png'),
    facebook: path.join(__dirname, '../../images/facebook icon.png'),
    instagram: path.join(__dirname, '../../images/instagram icon.png'),
    tiktok: path.join(__dirname, '../../images/tiktok.png'),
  };
  for (const [cid, filePath] of Object.entries(brand)) {
    const img = loadImage(filePath, cid);
    if (img) inlineImages.push(img);
  }
  const list = (Array.isArray(reasons) ? reasons : []).filter(Boolean);
  const reasonsHtml = list.length
    ? `<ul style="font-size: 14px; color: #000; line-height: 1.6; margin: 0 0 16px; padding-left: 20px; font-family: Arial, sans-serif;">${list.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
    : '';
  const noteHtml = note
    ? `<p style="font-size: 14px; color: #1D2740; line-height: 1.6; margin: 0 0 16px; font-family: Arial, sans-serif; background: #F7F9FC; border-left: 3px solid #124769; padding: 10px 12px;"><strong>Note from our team:</strong> ${esc(note)}</p>`
    : '';
  const shop = shopName ? ` for <strong>${esc(shopName)}</strong>` : '';
  const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your shop registration - Just Dry Cleaners</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif; }
      .email-container { max-width: 500px; margin: 20px auto; background-color: #ffffff; padding: 30px 20px; }
      @media (max-width: 520px) { .email-container { width: 100% !important; padding: 20px 15px !important; } }
    </style>
  </head>
  <body>
    <div class="email-container">
      <table align="center" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 30px;">
        <tr><td align="center"><img src="cid:logo" alt="Just Dry Cleaners" style="height: 60px; width: auto; display: block; margin: 0 auto;" /></td></tr>
      </table>
      <table align="center" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding: 0 20px;">
            <h2 style="font-size: 18px; color: #124769; margin-bottom: 16px; font-family: Arial, sans-serif; font-weight: normal;">Hi ${esc(userName)},</h2>
            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 16px; font-family: Arial, sans-serif;">
              Thank you for registering your shop${shop} with Just Dry Cleaners. We've reviewed your application and we can't approve it at the moment${list.length ? ' for the following reason' + (list.length > 1 ? 's' : '') + ':' : '.'}
            </p>
            ${reasonsHtml}
            ${noteHtml}
            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 16px; font-family: Arial, sans-serif;">
              If you can fix these, update your details in the Just Dry Cleaners shop app and reply to this email, and we'll take another look.
            </p>
            <p style="font-size: 14px; color: #000; margin-top: 10px; font-family: Arial, sans-serif; line-height: 1.8;">
              Kind regards,<br>
              Just Dry Cleaners Partner team
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
    subject: 'Your Just Dry Cleaners shop registration',
    html,
    inlineImages,
  };
}

module.exports = generateAgentRejectedTemplate;
