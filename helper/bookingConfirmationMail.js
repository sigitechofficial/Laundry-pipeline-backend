const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateBookingConfirmationTemplate } = require('./email');

/**
 * Send booking confirmation email using ZeptoMail API with inline images
 * @param {Object} params
 * @param {string} params.email - Recipient email address
 * @param {string} params.userName - Customer's first name
 * @param {string} params.orderNumber - Order tracking number
 * @param {string} params.address - Pickup street address
 * @param {string} params.postcode - Pickup postcode
 * @param {string} params.pickupDate - Collection date (formatted)
 * @param {string} params.pickupTimeFrom - Collection time from
 * @param {string} params.pickupTimeTo - Collection time to
 * @param {string} params.dropoffDate - Delivery date (formatted)
 * @param {string} params.dropoffTimeFrom - Delivery time from
 * @param {string} params.dropoffTimeTo - Delivery time to
 * @param {number} params.upfrontAmount - Minimum order hold amount
 * @param {string} params.currency - Currency symbol (default £)
 * @param {string} params.viewBookingLink - Link to view booking
 */
module.exports = async function (params) {
  const {
    email,
    userName = 'Customer',
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
    viewBookingLink
  } = params;

  console.log("📧 Sending Booking Confirmation Email via ZeptoMail API");
  console.log("   To:", email);
  console.log("   Order:", orderNumber);

  try {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
    const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

    const { subject, html, inlineImages } = generateBookingConfirmationTemplate({
      userName,
      email,
      orderNumber,
      address,
      postcode,
      pickupDate,
      pickupTimeFrom,
      pickupTimeTo,
      dropoffDate,
      dropoffTimeFrom,
      dropoffTimeTo,
      upfrontAmount,
      currency,
      viewBookingLink: viewBookingLink || 'https://prodlaundry.sigisolutions.net/my-bookings',
      footerOptions: {
        helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
        downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
        unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe'
      }
    });

    console.log(`📎 Prepared ${inlineImages?.length || 0} inline images for booking confirmation email`);

    await sendEmailViaAPI({
      from: {
        address: fromEmail,
        name: fromName
      },
      to: [email, 'sigidevelopers@gmail.com'],
      subject,
      html,
      inlineImages
    });

    console.log(`✅ Booking confirmation email sent successfully via ZeptoMail API`);
    return { success: true, message: 'Booking confirmation email sent successfully' };
  } catch (error) {
    console.error(`❌ Error in booking confirmation mail:`, error.message || error.error);
    console.error("Error details:", error.details || error);
    throw error;
  }
};
