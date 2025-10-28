require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ====== ENVIRONMENT CONFIG ======
const PORT = process.env.PORT || 3000;
const MOORLE_BASE = process.env.MOORLE_BASE || 'https://api.moolre.com';
const MOORLE_USERNAME = process.env.MOORLE_USERNAME || '';
const MOORLE_PUBLIC_API_KEY = process.env.MOORLE_PUBLIC_API_KEY || '';
const MOORLE_SECRET = process.env.MOORLE_SECRET || '';

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';

// ====== AIRTABLE HELPERS ======
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

async function airtableUpdate(recordId, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
  const res = await axios.patch(url, { fields }, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

async function airtableFindByOrderId(orderId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=({Order ID}='${orderId}')`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  return res.data.records && res.data.records.length ? res.data.records[0] : null;
}

// ====== HUBTEL SMS ======
async function sendHubtelSMS(to, message) {
  if (!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET) {
    console.warn('Hubtel credentials missing; skipping SMS.');
    return { success: false, error: 'no-credentials' };
  }
  const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
  const payload = {
    From: HUBTEL_SENDER,
    To: to,
    Content: message,
    ClientId: HUBTEL_CLIENT_ID
  };

  try {
    const res = await axios.post('https://api.hubtel.com/v1/messages', payload, {
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' }
    });
    return { success: true, data: res.data };
  } catch (err) {
    console.error('Hubtel send error', err.response?.data || err.message || err);
    return { success: false, error: err.response?.data || err.message };
  }
}

// ====== START CHECKOUT ======
app.post('/api/start-checkout', async (req, res) => {
  try {
    const { email, phone, recipient, network, deliveryType, dataPlan, amount, orderId } = req.body;
    const providedOrderId = orderId || ('T' + Math.floor(Math.random() * 900000000000000 + 100000000000000));

    if (!phone || !recipient || !network || !dataPlan || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Step 1: Create Airtable record
    const airtableFields = {
      "Order ID": providedOrderId,
      "Customer Phone": phone,
      "Customer Email": email || '',
      "Data Recipient Number": recipient,
      "Data Plan": dataPlan,
      "Amount": Number(amount),
      "Status": "Pending",
      "Hubtel Sent": "No",
      "Delivery Type": deliveryType || 'Normal'
    };
    const airtableRes = await airtableCreate(airtableFields);
    const airtableId = airtableRes.id;

    // Step 2: Create Moolre payment link
    const headers = {
      'Content-Type': 'application/json',
      'X-API-USER': MOORLE_USERNAME,
      'X-API-PUBKEY': MOORLE_PUBLIC_API_KEY
    };

    const payload = {
      type: 1,
      amount: Number(amount),
      currency: 'GHS',
      email: email || 'noemail@payconnect.com',
      reusable: false,
      externalref: providedOrderId,
      callback: `${process.env.BASE_URL || 'https://payconnect-moolre-backend.onrender.com'}/api/webhook/moorle`,
      accountnumber: '100000100002',
      metadata: { customer_id: phone }
    };

    const mRes = await axios.post(`${MOORLE_BASE}/embed/link`, payload, { headers });
    const mData = mRes.data || {};
    const paymentLink = mData.data?.payment_link || mData.data?.redirect_url || null;

    // Step 3: Update Airtable with Moolre response
    try {
      await airtableUpdate(airtableId, { "Moolre Response": JSON.stringify(mData) });
    } catch (err) {
      console.warn('Failed to update Airtable with Moorle response', err.message || err);
    }

    // Step 4: Return result
    return res.json({
      success: true,
      data: { airtableId, orderId: providedOrderId, paymentLink, moorle: mData }
    });

  } catch (err) {
    console.error('start-checkout error', err.response?.data || err.message || err);
    return res.status(500).json({
      error: 'Failed to start checkout',
      details: err.response?.data || err.message || ''
    });
  }
});

// ====== MOORLE WEBHOOK ======
app.post('/api/webhook/moorle', async (req, res) => {
  try {
    const payload = req.body || {};
    const data = payload.data || {};

    const incomingSecret = data.secret || payload.secret || '';
    if (!MOORLE_SECRET) {
      console.warn('MOORLE_SECRET not configured');
      return res.status(401).json({ error: 'Webhook secret not configured' });
    }
    if (incomingSecret !== MOORLE_SECRET) {
      console.warn('Invalid webhook secret');
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const txstatus = Number(data.txstatus || 0);
    const externalref = data.externalref || '';
    const payer = data.payer || '';
    const amount = data.amount || '';

    const record = await airtableFindByOrderId(externalref);
    if (!record) {
      console.warn('Airtable record not found for externalref', externalref);
      return res.json({ success: true, message: 'record-not-found' });
    }
    const airtableId = record.id;

    if (txstatus === 1) {
      const delivery = record.fields['Delivery Type'] || 'Normal';
      const dataPlan = record.fields['Data Plan'] || '';
      const recipient = record.fields['Data Recipient Number'] || '';
      const orderId = record.fields['Order ID'] || externalref;
      const deliveryText = (delivery === 'Express') ? '5–30 minutes' : '30 minutes to 4 hours';

      const sms = `Your data purchase of ${dataPlan} for ${recipient} has been processed and will be delivered in ${deliveryText}. Order ID: ${orderId}. For support, WhatsApp: 233531300654`;

      const smsResult = await sendHubtelSMS(payer || record.fields['Customer Phone'] || recipient, sms);

      await airtableUpdate(airtableId, {
        "Status": "Pending",
        "Hubtel Sent": smsResult && smsResult.success ? "Yes" : "No",
        "Moolre Response": JSON.stringify(payload)
      });

      return res.json({ success: true });
    } else {
      await airtableUpdate(airtableId, {
        "Moolre Response": JSON.stringify(payload),
        "Hubtel Sent": "No"
      });
      return res.json({ success: true });
    }

  } catch (err) {
    console.error('webhook handler error', err.response?.data || err.message || err);
    return res.status(500).json({ error: 'webhook handler internal error' });
  }
});

// ====== TEST ROUTE ======
app.get('/api/test', (req, res) => {
  res.json({ message: '✅ Payconnect Moorle backend is live!' });
});

app.listen(PORT, () => {
  console.log(`✅ Payconnect Moorle backend running on port ${PORT}`);
});
