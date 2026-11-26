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
function generateOnHoldTemplate(data) {
  const {
    userName = 'Customer',
    orderNumber = '',
    items = [],
    appLink = 'https://prodlaundry.sigisolutions.net/download',
    photoRoot = process.cwd(),
    footerOptions = {},
  } = data;

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

  let photos = 0;
  const rows = (Array.isArray(items) ? items : []).map((item, i) => {
    const name = [item.serviceName, item.itemName].filter(Boolean).join(' · ') || 'Item';
    const pieces = Number(item.pieces) || 0;
    let photoHtml = '';
    if (item.photo && photos < MAX_PHOTOS) {
      const resolved = path.isAbsolute(item.photo) ? item.photo : path.join(photoRoot, item.photo);
      const img = loadImage(resolved, `onhold${i}`);
      if (img) {
        photos += 1;
        inlineImages.push(img);
        photoHtml = `
                <td width="96" valign="top" style="padding-right: 14px;">
                  <img src="cid:onhold${i}" alt="Photo of the item" width="96" style="width: 96px; height: 96px; object-fit: cover; border-radius: 8px; display: block;" />
                </td>`;
      }
    }
    const risk = item.risk && item.risk.toLowerCase() !== 'other (see note)' ? item.risk : null;
    return `
          <table cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #DDE3EE; border-radius: 10px; margin-bottom: 12px;">
            <tr>
              <td style="padding: 14px;">
                <table cellpadding="0" cellspacing="0" width="100%"><tr>${photoHtml}
                  <td valign="top" style="font-family: Arial, sans-serif;">
                    <p style="margin: 0 0 6px; font-size: 15px; font-weight: bold; color: #124769;">${esc(name)}${pieces > 1 ? ` <span style="font-weight: normal; color: #56617A;">(${pieces} pieces)</span>` : ''}</p>
                    ${risk ? `<p style="margin: 0 0 6px; font-size: 14px; color: #92400E;"><strong>Issue:</strong> ${esc(risk)}</p>` : ''}
                    ${item.shopNote ? `<p style="margin: 0; font-size: 14px; color: #1D2740; line-height: 1.5;"><strong>Our note:</strong> ${esc(item.shopNote)}</p>` : ''}
                  </td>
                </tr></table>
              </td>
            </tr>
          </table>`;
  });

  const count = rows.length;
  const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Items on hold - Just Dry Cleaners</title>
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
            <h2 style="font-size: 18px; color: #124769; margin-bottom: 16px; font-family: Arial, sans-serif; font-weight: normal;">Dear ${esc(userName)},</h2>
            <p style="font-size: 15px; color: #000; line-height: 1.6; margin-bottom: 16px; font-family: Arial, sans-serif;">
              While checking your order <strong>#${esc(orderNumber)}</strong>, we found something we need to ask you about before we clean ${count === 1 ? 'this item' : `these ${count} items`}.
            </p>
            ${rows.join('')}
            <p style="font-size: 15px; color: #000; line-height: 1.6; margin: 18px 0 8px; font-family: Arial, sans-serif;">
              Please open the Just Dry Cleaners app and choose for each item:
            </p>
            <ul style="font-size: 14px; color: #000; line-height: 1.6; margin: 0 0 18px; padding-left: 20px; font-family: Arial, sans-serif;">
              <li><strong>Clean it</strong>: you accept the risk and we go ahead.</li>
              <li><strong>Don't clean it</strong>: we return it uncleaned and take it off your bill.</li>
            </ul>
            <table cellpadding="0" cellspacing="0" width="100%" style="margin: 10px 0 25px 0;">
              <tr><td align="center">
                <a href="${esc(appLink)}" style="display: inline-block; background-color: #124769; color: #ffffff; font-size: 16px; font-weight: bold; font-family: Arial, sans-serif; text-decoration: none; padding: 14px 44px; border-radius: 30px;">Review in the app</a>
              </td></tr>
            </table>
            <p style="font-size: 14px; color: #000; line-height: 1.6; margin-bottom: 20px; font-family: Arial, sans-serif;">
              The rest of your order carries on as normal. We'll only clean ${count === 1 ? 'this item' : 'these items'} once you've told us what to do.
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
    subject: `Action needed: ${count === 1 ? 'an item' : `${count} items`} on hold - Order #${orderNumber} - Just Dry Cleaners`,
    html,
    inlineImages,
  };
}

module.exports = generateOnHoldTemplate;
