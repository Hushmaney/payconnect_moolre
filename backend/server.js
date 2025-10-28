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
const MOOLRE_USERNAME = process.env.MOOLRE_USERNAME || ''; // ✅ Corrected spelling
const MOOLRE_SECRET = process.env.MOOLRE_SECRET || '';

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';
const BASE_URL = process.env.BASE_URL || 'https://payconnect-moolre-backend.onrender.com';

// ====== AIRTABLE CREATE RECORD ======
async function airtableCreate(fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  const res = await axios.post(url, { fields }, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

// ====== HUBTEL SMS ======
async function sendHubtelSMS(to, message) {
  try {
    const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
    const payload = {
      From: HUBTEL_SENDER,
      To: to,
      Content: message,
      ClientId: HUBTEL_CLIENT_ID
    };

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

    const orderId = 'T' + Math.floor(Math.random() * 900000000000000 + 100000000000000);

    // Request payment link from Moolre
    const headers = {
      'Content-Type': 'application/json',
      'X-API-PUBKEY': MOOLRE_PUBLIC_API_KEY
    };

    const payload = {
      type: 1,
      amount: Number(amount),
      currency: 'GHS',
      username: MOOLRE_USERNAME, // ✅ Include username in payload
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
    const paymentLink = moolreData.data?.payment_link || moolreData.data?.redirect_url;

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
  try {
    const payload = req.body || {};
    const data = payload.data || {};
    const incomingSecret = data.secret || payload.secret || '';

    if (incomingSecret !== MOOLRE_SECRET) {
      console.warn('Invalid webhook secret');
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
      const smsText = `Payment received for ${dataPlan || 'your order'} (${amount} GHS). Your data will be delivered shortly. Order ID: ${externalref}. For support: WhatsApp 0531300654`;

      const smsResult = await sendHubtelSMS(payer || recipient, smsText);
      const hubtelSent = smsResult.success ? 'Yes' : 'No';
      const hubtelResponse = JSON.stringify(smsResult.data || smsResult.error || {});

      const fields = {
        "Order ID": externalref,
        "Customer Phone": payer,
        "Data Recipient Number": recipient,
        "Data Plan": dataPlan,
        "Amount": Number(amount),
        "Status": "Pending",
        "Hubtel Sent": hubtelSent,
        "Hubtel Response": hubtelResponse
      };

      await airtableCreate(fields);
      return res.json({ success: true, message: 'Airtable record created and SMS sent' });
    }

    return res.json({ success: true, message: 'Payment not successful' });
  } catch (err) {
    console.error('webhook handler error', err.response?.data || err.message);
    return res.status(500).json({ error: 'webhook handler internal error' });
  }
});

// ====== TEST ROUTE ======
app.get('/api/test', (req, res) => {
  res.json({ message: '✅ Payconnect Moolre backend is live!' });
});

app.listen(PORT, () => {
  console.log(`✅ Payconnect Moolre backend running on port ${PORT}`);
});
