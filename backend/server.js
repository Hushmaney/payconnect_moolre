require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ====== ENVIRONMENT CONFIG ======
const PORT = process.env.PORT || 3000; 
const MOOLRE_BASE = process.env.MOOLRE_BASE || 'https://api.moolre.com';
const MOOLRE_PUBLIC_API_KEY = process.env.MOOLRE_PUBLIC_API_KEY || '';
const MOOLRE_USERNAME = process.env.MOOLRE_USERNAME || ''; 
const MOOLRE_SECRET = process.env.MOOLRE_SECRET || '';
// Account number is required for the /embed/link payload
const MOOLRE_ACCOUNT_NUMBER = process.env.MOOLRE_ACCOUNT_NUMBER || ''; 

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';
const BASE_URL = process.env.BASE_URL || 'https://payconnect-moolre-backend.onrender.com';

// ====== AIRTABLE CREATE RECORD ======
// Note: This is a utility function; the 'Status' field is explicitly set 
// in the calling webhook function.
async function airtableCreate(fields) {
  // CRITICAL: Check for Airtable configuration before attempting API call
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE) {
    console.error('Airtable environment variables (AIRTABLE_API_KEY or AIRTABLE_BASE) are missing.');
    // Throw an error to stop execution if config is bad
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
    // This creates the Base64 encoded string of CLIENT_ID:CLIENT_SECRET
    const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
    
    // Check if the keys are actually present before sending
    if (!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET) {
        console.error('Hubtel keys are missing, skipping SMS send.');
        return { success: false, error: 'Configuration missing' };
    }

    const payload = {
      From: HUBTEL_SENDER,
      To: to,
      Content: message,
      ClientId: HUBTEL_CLIENT_ID
    };

    // The Authorization header must be 'Basic ' followed by the Base64 token
    const res = await axios.post('https://api.hubtel.com/v1/messages', payload, {
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' }
    });

    return { success: true, data: res.data };
  } catch (err) {
    // Log detailed error from Hubtel
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

    // Generate a unique order ID for transaction tracking
    const orderId = 'T' + Math.floor(Math.random() * 900000000000000 + 100000000000000);

    // Request payment link from Moolre
    const headers = {
      'Content-Type': 'application/json',
      // Required headers as per documentation for /embed/link
      'X-API-PUBKEY': MOOLRE_PUBLIC_API_KEY,
      'X-API-USER': MOOLRE_USERNAME 
    };

    const payload = {
      type: 1,
      amount: Number(amount),
      currency: 'GHS',
      // REQUIRED: Use accountnumber field for /embed/link endpoint
      accountnumber: MOOLRE_ACCOUNT_NUMBER, 
      email: email || 'noemail@payconnect.com',
      reusable: false,
      externalref: orderId,
      callback: `${BASE_URL}/api/webhook/moolre`,
      metadata: {
        customer_id: phone,
        dataPlan,
        recipient
      }
    };

    const response = await axios.post(`${MOOLRE_BASE}/embed/link`, payload, { headers });
    const moolreData = response.data;
    // Use authorization_url as primary field as per Moolre docs
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
    // Extract the incoming secret sent by Moolre. Defaults to empty string if missing.
    const incomingSecret = data.secret || payload.secret || '';

    // Webhook secret validation check
    if (incomingSecret !== MOOLRE_SECRET) {
      console.warn('Invalid webhook secret: Mismatch detected. Blocking request.');
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const txstatus = Number(data.txstatus || 0);
    const externalref = data.externalref || '';
    const payer = data.payer || '';
    const amount = data.amount || '';
    const dataPlan = data.metadata?.dataPlan || '';
    const recipient = data.metadata?.recipient || '';

    if (txstatus === 1) {
      // ✅ Payment successful 
      
      // 1. Send confirmation SMS with customized message
      try {
        // Updated SMS message with the custom details you requested
        const smsText = `Your data purchase of ${dataPlan} for ${recipient} has been processed and will be delivered in 30 minutes to 4 hours. Order ID: ${externalref}. For support, WhatsApp: 233531300654`;
        smsResult = await sendHubtelSMS(payer || recipient, smsText); 
      } catch (smsError) {
        console.error('Failed to send Hubtel SMS, proceeding with Airtable log:', smsError.message);
        smsResult.error = `Failed to send SMS: ${smsError.message}`;
      }
      
      const hubtelSent = smsResult.success ? 'Yes' : 'No';
      const hubtelResponse = JSON.stringify(smsResult.data || smsResult.error || {});

      // 2. CREATE AIRTABLE RECORD HERE
      const fields = {
        "Order ID": externalref,
        "Customer Phone": payer,
        "Data Recipient Number": recipient,
        "Data Plan": dataPlan,
        "Amount": Number(amount),
        // This is correctly set to 'Pending' as requested for manual fulfillment
        "Status": "Pending", 
        "Hubtel Sent": hubtelSent,
        "Hubtel Response": hubtelResponse
      };

      await airtableCreate(fields);
      console.log(`✅ Airtable Record created for Order ID: ${externalref}`);
      return res.json({ success: true, message: 'Airtable record created and SMS attempted' });
    }

    // Handle failed or cancelled transactions if necessary
    console.log(`Payment not successful (Status: ${txstatus}). No Airtable record created.`);
    return res.json({ success: true, message: 'Payment not successful' });
  } catch (err) {
    // This catches errors from the airtableCreate call or other synchronous errors
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
