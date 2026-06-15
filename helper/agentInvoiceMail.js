const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateAgentOrderInvoiceTemplate } = require('./email');

const DEFAULT_FOOTER_OPTIONS = {
  helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
  downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
  unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe'
};

/**
 * Send order invoice finalized email to shop agent
 * @param {Object} params
 * @param {string} params.email - Agent email address
 * @param {string} params.agentName - Agent's first name
 * @param {string} params.shopName - Shop name
 * @param {string} params.orderNumber - Order tracking number
 * @param {string} params.customerName - Customer name
 * @param {number|string} params.finalAmount - Final invoice total
 * @param {string} [params.currency] - Currency symbol (default £)
 * @param {string} [params.viewOrderLink] - Link to view order
 */
module.exports = async function ({
  email,
  agentName = 'Agent',
  shopName = 'Your shop',
  orderNumber = '',
  customerName = 'Customer',
  finalAmount = '0.00',
  currency = '£',
  viewOrderLink
}) {
  console.log('📧 Sending Agent Order Invoice Email via ZeptoMail API');
  console.log('   To:', email);
  console.log('   Order:', orderNumber);

  try {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
    const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

    const { subject, html, inlineImages } = generateAgentOrderInvoiceTemplate({
      agentName,
      shopName,
      orderNumber,
      customerName,
      finalAmount,
      currency,
      viewOrderLink: viewOrderLink || 'https://prodlaundry.sigisolutions.net/agent/orders',
      footerOptions: DEFAULT_FOOTER_OPTIONS
    });

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

    console.log('✅ Agent order invoice email sent successfully via ZeptoMail API');
    return { success: true, message: 'Agent order invoice email sent successfully' };
  } catch (error) {
    console.error('❌ Error in agent order invoice mail:', error.message || error.error);
    console.error('Error details:', error.details || error);
    throw error;
  }
};
