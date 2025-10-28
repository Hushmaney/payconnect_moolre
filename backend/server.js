const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Utility to strip all non-digit characters from a phone number
// This is used to ensure Hubtel only receives digits.
function cleanPhoneNumber(phone) {
  // Check if phone is a string before running replace
  return typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
}

// Function to safely extract a number string from a complex payer string (e.g., "Name (233...)")
function extractNumberFromPayer(payerString, metadataPhone) {
  if (!payerString) {
    return metadataPhone || '';
  }
  
  // Regex to find a number within parentheses, or the whole string if no parentheses
  const match = payerString.match(/\(([^)]+)\)/);
  if (match && match[1]) {
    // If a number is found in parentheses (e.g., "233531300654")
    return match[1];
  }
  // Otherwise, return the original payer string or the metadata phone
  return payerString || metadataPhone || '';
}

// ====== ENVIRONMENT CONFIG ======
const PORT = process.env.PORT || 3000; 
const MOOLRE_BASE = process.env.MOOLRE_BASE || 'https://api.moolre.com';
const MOOLRE_PUBLIC_API_KEY = process.env.MOOLRE_PUBLIC_API_KEY || '';
const MOOLRE_USERNAME = process.env.MOOLRE_USERNAME || ''; 
const MOOLRE_SECRET = process.env.MOOLRE_SECRET || '';
const MOOLRE_ACCOUNT_NUMBER = process.env.MOOLRE_ACCOUNT_NUMBER || ''; 

// These variables MUST be set correctly in the Render Dashboard
const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';
const BASE_URL = process.env.BASE_URL || 'https://payconnect-moolre-backend.onrender.com';

// ====== AIRTABLE CREATE RECORD ======
async function airtableCreate(fields) {
  // CRITICAL: Check for Airtable configuration before attempting API call
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE) {
    console.error('Airtable environment variables (AIRTABLE_API_KEY or AIRTABLE_BASE) are missing.');
    throw new Error('Airtable configuration missing.'); 
  }

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  
  try {
    const res = await axios.post(url, { fields }, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return res.data;
  } catch (err) {
    console.error('Airtable API error:', err.response?.data || err.message);
    throw new Error('Failed to create record in Airtable.'); 
  }
}

// ====== HUBTEL SMS ======
async function sendHubtelSMS(to, message) {
  try {
    // Clean the destination number to remove spaces/symbols (Fix for Invalid Destination error)
    const cleanedTo = cleanPhoneNumber(to); 
    
    // Check if the keys are actually present before sending
    if (!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET) {
        // This log is what we are trying to avoid hitting now
        console.error('Hubtel keys are missing, skipping SMS send.');
        return { success: false, error: 'Configuration missing' };
    }

    // --- DEBUGGING LOG (Temporary) ---
    // This helps confirm the exact length of the keys being read by the server
    console.log(`[HUBTEL DEBUG] Client ID Length: ${HUBTEL_CLIENT_ID.length}, Secret Length: ${HUBTEL_CLIENT_SECRET.length}`);
    // --- END DEBUGGING LOG ---

    const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');

    const payload = {
      From: HUBTEL_SENDER,
      // Use the cleaned number
      To: cleanedTo,
      // ClientId is omitted from the body payload as authentication is done via the header
    };
    
    // CRITICAL: Hubtel requires the message content
    if (message) {
      payload.Content = message;
    } else {
      console.warn('SMS message content is empty.');
    }


    const res = await axios.post('https://api.hubtel.com/v1/messages', payload, {
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' }
    });

    return { success: true, data: res.data };
  } catch (err) {
    console.error('Hubtel send error', err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

// ====== START CHECKOUT (PAYMENT INITIATION) ======
app.post('/api/start-checkout', async (req, res) => {
  try {
    const { email, phone, recipient, dataPlan, amount } = req.body;

    if (!phone || !recipient || !dataPlan || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!MOOLRE_ACCOUNT_NUMBER || !MOOLRE_USERNAME || !MOOLRE_PUBLIC_API_KEY) {
         console.error('Moolre environment variables missing.');
         return res.status(500).json({ error: 'Server configuration error (Moolre keys missing)' });
    }

    const orderId = 'T' + Math.floor(Math.random() * 900000000000000 + 100000000000000);

    const headers = {
      'Content-Type': 'application/json',
      'X-API-PUBKEY': MOOLRE_PUBLIC_API_KEY,
      'X-API-USER': MOOLRE_USERNAME 
    };

    const payload = {
      type: 1,
      amount: Number(amount),
      currency: 'GHS',
      accountnumber: MOOLRE_ACCOUNT_NUMBER, 
      email: email || 'noemail@payconnect.com',
      reusable: false,
      externalref: orderId,
      callback: `${BASE_URL}/api/webhook/moolre`,
      metadata: {
        customer_id: phone, // <-- Customer's phone is correctly saved here
        dataPlan,
        recipient
      }
    };

    const response = await axios.post(`${MOOLRE_BASE}/embed/link`, payload, { headers });
    const moolreData = response.data;
    const paymentLink = moolreData.data?.authorization_url || moolreData.data?.redirect_url; 

    if (!paymentLink) {
      console.error('Moolre response missing payment link:', moolreData);
      return res.status(400).json({ error: 'No payment link received', details: moolreData });
    }

    return res.json({ success: true, orderId, paymentLink, moolreData });
  } catch (err) {
    console.error('start-checkout error', err.response?.data || err.message);
    return res.status(500).json({
      error: 'Failed to start checkout',
      details: err.response?.data || err.message
    });
  }
});

// ====== MOOLRE WEBHOOK (PAYMENT CONFIRMATION) ======
app.post('/api/webhook/moolre', async (req, res) => {
  let smsResult = { success: false, error: 'SMS not attempted' };
  try {
    const payload = req.body || {};
    const data = payload.data || {};
    const incomingSecret = data.secret || payload.secret || '';

    // Webhook secret validation check
    if (incomingSecret !== MOOLRE_SECRET) {
      console.warn('Invalid webhook secret: Mismatch detected. Blocking request.');
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const txstatus = Number(data.txstatus || 0);
    const externalref = data.externalref || '';
    
    // Original payer field from Moolre (e.g., "Name (233...)")
    const payerFromMoolre = data.payer || ''; 
    const metadataPhone = data.metadata?.customer_id || '';
    
    // CRITICAL FIX: Extract the clean number string from the complex payer field, falling back to metadata phone
    const customerPhoneRaw = extractNumberFromPayer(payerFromMoolre, metadataPhone);
    const customerPhone = cleanPhoneNumber(customerPhoneRaw);
    
    const amount = data.amount || '';
    const dataPlan = data.metadata?.dataPlan || '';
    const recipient = data.metadata?.recipient || '';

    if (txstatus === 1) {
      // ✅ Payment successful 
      
      // 1. Send confirmation SMS
      try {
        const smsText = `Your data purchase of ${dataPlan} for ${recipient} has been processed and will be delivered in 30 minutes to 4 hours. Order ID: ${externalref}. For support, WhatsApp: 233531300654`;
        // Use the reliably retrieved and cleaned customerPhone
        smsResult = await sendHubtelSMS(customerPhone, smsText); 
      } catch (smsError) {
        console.error('Failed to send Hubtel SMS, proceeding with Airtable log:', smsError.message);
        smsResult.error = `Failed to send SMS: ${smsError.message}`;
      }
      
      // Use the boolean success value directly for Airtable (true/false)
      const hubtelSent = smsResult.success; 
      const hubtelResponse = JSON.stringify(smsResult.data || smsResult.error || {});

      // 2. CREATE AIRTABLE RECORD HERE
      const fields = {
        "Order ID": externalref,
        "Customer Phone": customerPhone, // Now contains only the clean number
        "Data Recipient Number": recipient,
        "Data Plan": dataPlan,
        "Amount": Number(amount),
        "Status": "Pending", 
        "Hubtel Sent": hubtelSent, // Now a boolean: true or false
        "Hubtel Response": hubtelResponse
      };

      await airtableCreate(fields);
      console.log(`✅ Airtable Record created for Order ID: ${externalref}`);
      return res.json({ success: true, message: 'Airtable record created and SMS attempted' });
    }

    // Handle failed or cancelled transactions
    console.log(`Payment not successful (Status: ${txstatus}). No Airtable record created.`);
    return res.json({ success: true, message: 'Payment not successful' });
  } catch (err) {
    console.error('webhook handler internal error:', err.message);
    return res.status(500).json({ error: 'webhook handler internal error', details: err.message });
  }
});

// ====== TEST ROUTE ======
app.get('/api/test', (req, res) => {
  res.json({ message: '✅ Payconnect Moolre backend is live!' });
});

app.listen(PORT, () => {
  console.log(`✅ Payconnect Moolre backend running on port ${PORT}`);
});
