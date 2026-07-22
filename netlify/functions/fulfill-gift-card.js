const { Resend } = require('resend');
const crypto = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY);
const SNIPCART_SECRET = process.env.SNIPCART_SECRET_API_KEY;

function generateRandomCode() {
  // crypto.randomInt (CSPRNG) instead of Math.random -- these codes are
  // redeemable money (a single-use discount worth up to $500), so they
  // must not come from a predictable PRNG.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'YALL-';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(crypto.randomInt(chars.length));
  }
  return result;
}

// Escape user-supplied text before interpolating it into the email HTML.
// Sender Name / Message come straight from checkout custom fields, so
// without this a buyer could inject arbitrary HTML (links, fake buttons,
// hidden text) into an email that lands in someone ELSE's inbox from
// gifts@yallternativeliving.com -- a ready-made phishing vector.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

exports.handler = async (event) => {
  // 1. Only allow POST requests (Snipcart webhooks are POST)
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 2. Validate the request comes from Snipcart
  const requestToken = event.headers['x-snipcart-requesttoken'] || event.headers['X-Snipcart-RequestToken'];
  if (!requestToken) {
    return { statusCode: 401, body: 'Missing Snipcart request token' };
  }

  try {
    const validationResponse = await fetch(`https://app.snipcart.com/api/requestvalidation/${requestToken}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(SNIPCART_SECRET + ':').toString('base64')}`
      }
    });

    if (!validationResponse.ok) {
      console.error('Snipcart validation failed', validationResponse.status);
      return { statusCode: 401, body: 'Invalid request token' };
    }

    // 3. Parse the webhook body
    const payload = JSON.parse(event.body);
    
    // We only care about completed orders
    if (payload.eventName !== 'order.completed') {
      return { statusCode: 200, body: 'Event ignored' };
    }

    const order = payload.content;
    const items = order.items || [];
    
    // 4. Find any gift cards in the order
    const giftCards = items.filter(item => item.id === 'yallternative-gift-card');
    
    if (giftCards.length === 0) {
      return { statusCode: 200, body: 'No gift cards in order' };
    }

    // 5. Process each gift card
    for (const card of giftCards) {
      // Extract custom fields securely
      const getField = (name) => {
        const field = (card.customFields || []).find(f => f.name === name);
        return field ? field.value : '';
      };

      const recipientEmail = getField('Recipient Email');
      const senderName = getField('Sender Name');
      // The buy button in shop.html names this field "Message"
      // (data-item-custom4-name) -- the old lookup for
      // 'Personal Message (Optional)' never matched, so the buyer's
      // note was silently dropped from every gift email. Check the
      // real name first, keep the old one as a fallback.
      const personalMessage = getField('Message') || getField('Personal Message (Optional)');
      const amount = card.unitPrice; // The price they paid for the card is the balance

      if (!recipientEmail) {
        console.error('Gift card missing recipient email. Order:', order.invoiceNumber);
        continue;
      }

      // Generate a unique code
      const uniqueCode = generateRandomCode();

      // 6. Create the Discount in Snipcart
      const discountPayload = {
        name: `Gift Card from ${(senderName || 'a friend').slice(0, 80)}`,
        code: uniqueCode,
        type: 'FixedAmount',
        amount: amount,
        maxNumberOfUsages: 1,
      };

      const discountResponse = await fetch('https://app.snipcart.com/api/discounts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Basic ${Buffer.from(SNIPCART_SECRET + ':').toString('base64')}`
        },
        body: JSON.stringify(discountPayload)
      });

      if (!discountResponse.ok) {
        console.error('Failed to create Snipcart discount', await discountResponse.text());
        continue;
      }

      // 7. Send the Email via Resend
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">You've received a gift!</h1>
          <p style="font-size: 18px;"><strong>${escapeHtml(senderName) || 'Someone special'}</strong> sent you a $${amount.toFixed(2)} gift card to Y'allternative Living.</p>
          
          ${personalMessage ? `<div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 8px; font-style: italic; margin: 20px 0;">"${escapeHtml(personalMessage)}"</div>` : ''}
          
          <div style="text-align: center; background: #fff; color: #000; padding: 20px; border-radius: 8px; margin: 30px 0;">
            <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 14px; color: #666;">Your Gift Code</p>
            <h2 style="margin: 10px 0 0 0; font-size: 32px; letter-spacing: 4px;">${uniqueCode}</h2>
          </div>
          
          <div style="text-align: center;">
            <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 15px 30px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Shop Now</a>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: 'gifts@yallternativeliving.com',
        to: recipientEmail,
        subject: `You received a $${amount.toFixed(2)} Y'allternative Living gift card!`,
        html: emailHtml,
      });

      console.log(`Successfully generated and sent gift card ${uniqueCode} to ${recipientEmail}`);
    }

    return { statusCode: 200, body: 'Webhook processed successfully' };

  } catch (error) {
    console.error('Webhook processing error:', error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
