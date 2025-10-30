const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ====== HELPERS ======
function cleanPhoneNumber(phone) {
  return typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
}

function extractNumberFromPayer(payerString, metadataPhone) {
  if (!payerString) return metadataPhone || '';
  const match = payerString.match(/\(([^)]+)\)/);
  if (match && match[1]) return match[1];
  return payerString || metadataPhone || '';
}

// ====== ENVIRONMENT CONFIG ======
const PORT = process.env.PORT || 3000;
const MOOLRE_BASE = process.env.MOOLRE_BASE || 'https://api.moolre.com';
const MOOLRE_PUBLIC_API_KEY = process.env.MOOLRE_PUBLIC_API_KEY || '';
const MOOLRE_USERNAME = process.env.MOOLRE_USERNAME || '';
const MOOLRE_SECRET = process.env.MOOLRE_SECRET || '';
const MOOLRE_ACCOUNT_NUMBER = process.env.MOOLRE_ACCOUNT_NUMBER || '';
const FINAL_REDIRECT_URL = 'https://ovaldataafrica.glide.page/';

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';
const BASE_URL = process.env.BASE_URL || 'https://payconnect-moolre-backend.onrender.com';

// ====== IDENTITY TRACKER (to prevent duplicates) ======
const processedOrders = new Set();

// ====== AIRTABLE READ RECORD ======
async function airtableRead(externalRef) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE) {
    console.error('Airtable environment variables missing for read.');
    return null;
  }

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(
    AIRTABLE_TABLE
  )}?filterByFormula=({Order ID}='${externalRef}')`;

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      },
    });
    return res.data.records;
  } catch (err) {
    console.error('Airtable Read API error:', err.response?.data || err.message);
    return null;
  }
}

// ====== AIRTABLE CREATE RECORD ======
async function airtableCreate(fields) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE) {
    console.error('Airtable environment variables missing.');
    throw new Error('Airtable configuration missing.');
  }

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(
    AIRTABLE_TABLE
  )}`;

  try {
    const res = await axios.post(
      url,
      { fields },
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return res.data;
  } catch (err) {
    console.error('Airtable API error:', err.response?.data || err.message);
    throw new Error('Failed to create record in Airtable.');
  }
}

// ====== HUBTEL SMS ======
async function sendHubtelSMS(to, message) {
  try {
    const cleanedTo = cleanPhoneNumber(to);

    if (!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET) {
      console.error('Hubtel keys missing. Cannot send SMS.');
      return { success: false, error: 'Missing credentials' };
    }

    const token = Buffer.from(
      `${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`
    ).toString('base64');
    const payload = {
      From: HUBTEL_SENDER,
      To: cleanedTo,
      Content: message,
    };

    const res = await axios.post(
      'https://smsc.hubtel.com/v1/messages/send',
      payload,
      {
        headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
      }
    );

    return { success: true, data: res.data };
  } catch (err) {
    console.error('Hubtel send error', err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

// ====== START CHECKOUT ======
app.post('/api/start-checkout', async (req, res) => {
  try {
    const { email, phone, recipient, dataPlan, amount } = req.body;

    if (!phone || !recipient || !dataPlan || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!MOOLRE_ACCOUNT_NUMBER || !MOOLRE_USERNAME || !MOOLRE_PUBLIC_API_KEY) {
      console.error('Moolre environment variables missing.');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const orderId =
      'T' + Math.floor(Math.random() * 900000000000000 + 100000000000000);
    const headers = {
      'Content-Type': 'application/json',
      'X-API-PUBKEY': MOOLRE_PUBLIC_API_KEY,
      'X-API-USER': MOOLRE_USERNAME,
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
      redirect: FINAL_REDIRECT_URL,
      metadata: { customer_id: phone, dataPlan, recipient, email },
    };

    const response = await axios.post(`${MOOLRE_BASE}/embed/link`, payload, {
      headers,
    });
    const moolreData = response.data;
    const paymentLink =
      moolreData.data?.authorization_url || moolreData.data?.redirect_url;

    if (!paymentLink) {
      console.error('Moolre response missing payment link:', moolreData);
      return res
        .status(400)
        .json({ error: 'No payment link received', details: moolreData });
    }

    return res.json({ success: true, orderId, paymentLink, moolreData });
  } catch (err) {
    console.error('start-checkout error', err.response?.data || err.message);
    return res
      .status(500)
      .json({ error: 'Failed to start checkout', details: err.message });
  }
});

// ====== MOOLRE WEBHOOK (IDEMPOTENT VERSION) ======
app.post('/api/webhook/moolre', async (req, res) => {
  // Respond immediately to prevent Moolre retries
  res.status(200).json({ success: true });

  try {
    const payload = req.body || {};
    const data = payload.data || {};
    const incomingSecret = data.secret || payload.secret || '';

    if (incomingSecret !== MOOLRE_SECRET) {
      console.warn('Invalid webhook secret');
      return;
    }

    const txstatus = Number(data.txstatus || 0);
    const externalref = data.externalref || '';
    if (!externalref) return;

    // Prevent duplicate execution
    if (processedOrders.has(externalref)) {
      console.log(`⚠️ Duplicate webhook ignored for Order ID: ${externalref}`);
      return;
    }
    processedOrders.add(externalref);
    // optional: auto-clear after 1 minute
    setTimeout(() => processedOrders.delete(externalref), 60000);

    const payerFromMoolre = data.payer || '';
    const metadataPhone = data.metadata?.customer_id || '';
    const customerPhoneRaw = extractNumberFromPayer(payerFromMoolre, metadataPhone);
    const customerPhone = cleanPhoneNumber(customerPhoneRaw);
    const email = data.metadata?.email || data.email || 'noemail@payconnect.com';
    const amount = data.amount || '';
    const dataPlanWithDelivery = data.metadata?.dataPlan || '';
    const recipient = data.metadata?.recipient || '';

    const isExpress = dataPlanWithDelivery.toLowerCase().includes('(express)');

    if (txstatus !== 1) {
      console.log(`Payment not successful (Status: ${txstatus}).`);
      return;
    }

    const existingRecords = await airtableRead(externalref);
    if (existingRecords && existingRecords.length > 0) {
      console.log(`⚠️ Duplicate ignored. Already in Airtable: ${externalref}`);
      return;
    }

    let smsText = isExpress
      ? `Your data purchase of ${dataPlanWithDelivery} for ${recipient} has been processed and will be delivered in 5-30 minutes. Order ID: ${externalref}. For support, WhatsApp: 233531300654;`
      : `Your data purchase of ${dataPlanWithDelivery} for ${recipient} has been processed and will be delivered in 30 minutes to 4 hours. Order ID: ${externalref}. For support, WhatsApp: 233531300654;`;

    const smsResult = await sendHubtelSMS(customerPhone, smsText);

    const fields = {
      'Order ID': externalref,
      'Customer Phone': customerPhone,
      'Customer Email': email,
      'Data Recipient Number': recipient,
      'Data Plan': dataPlanWithDelivery,
      Amount: Number(amount),
      Status: 'Pending',
      'Hubtel Sent': smsResult.success,
      'Hubtel Response': JSON.stringify(smsResult.data || smsResult.error || {}),
    };

    await airtableCreate(fields);
    console.log(`✅ Airtable Record created for Order ID: ${externalref}`);
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }
});

// ====== TEST ROUTE ======
app.get('/api/test', (req, res) => {
  res.json({ message: '✅ Payconnect Moolre backend is live!' });
});

app.listen(PORT, () => {
  console.log(`✅ Payconnect Moolre backend running on port ${PORT}`);
});
