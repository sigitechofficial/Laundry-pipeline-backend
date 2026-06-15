const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateInvoiceReadyTemplate } = require('./email');

/**
 * Send invoice ready email using ZeptoMail API with inline images
 * @param {Object} params
 * @param {string} params.email - Recipient email address
 * @param {string} params.userName - Customer's first name
 * @param {string} params.orderNumber - Order tracking number
 * @param {number|string} params.finalAmount - Final total due amount
 * @param {string} params.currency - Currency symbol (default £)
 * @param {string} params.payNowLink - Payment link
 */
module.exports = async function ({ email, userName = 'Customer', orderNumber = '', finalAmount = '0.00', currency = '£', payNowLink }) {
  console.log("📧 Sending Invoice Ready Email via ZeptoMail API");
  console.log("   To:", email);
  console.log("   Order:", orderNumber);
  console.log("   Amount:", `${currency}${finalAmount}`);

  try {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
    const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

    const { subject, html, inlineImages } = generateInvoiceReadyTemplate({
      userName,
      orderNumber,
      finalAmount,
      currency,
      payNowLink: payNowLink || 'https://prodlaundry.sigisolutions.net/pay',
      footerOptions: {
        helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
        downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
        unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe'
      }
    });

    console.log(`📎 Prepared ${inlineImages?.length || 0} inline images for invoice ready email`);

    await sendEmailViaAPI({
      from: {
        address: fromEmail,
        name: fromName
      },
      to: email,
      subject,
      html,
      inlineImages
    });

    console.log(`✅ Invoice ready email sent successfully via ZeptoMail API`);
    return { success: true, message: 'Invoice ready email sent successfully' };
  } catch (error) {
    console.error(`❌ Error in invoice ready mail:`, error.message || error.error);
    console.error("Error details:", error.details || error);
    throw error;
  }
};
