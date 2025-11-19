// ===========================================
// Payconnect Moolre Backend (Updated & Fixed)
// ===========================================

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

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';

// ====== MEMORY LOCK ======
const processedOrders = new Set();
const pendingTransactions = new Map();

// ====== CHANNEL DETECTION ======
function getChannelId(payerNumber) {
  const prefix = payerNumber.substring(0, 3);
  if (['024', '054', '055'].includes(prefix)) return 13; // MTN
  if (['020', '050'].includes(prefix)) return 6; // Vodafone
  if (['026', '056'].includes(prefix)) return 7; // AirtelTigo
  return 13; // default MTN
}

// ====== AIRTABLE HELPERS ======
async function airtableRead(externalRef) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE) return null;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=({Order ID}='${externalRef}')`;
  try {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    return res.data.records;
  } catch (err) {
    console.error('Airtable Read Error:', err.response?.data || err.message);
    return null;
  }
}

async function airtableCreate(fields) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE) throw new Error('Airtable configuration missing.');
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  try {
    const res = await axios.post(url, { fields }, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (err) {
    console.error('Airtable Create Error:', err.response?.data || err.message);
    throw new Error('Failed to create record in Airtable.');
  }
}

// ====== HUBTEL SMS ======
async function sendHubtelSMS(to, message) {
  try {
    if (!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET) throw new Error('Hubtel credentials missing.');
    const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
    const payload = { From: HUBTEL_SENDER, To: cleanPhoneNumber(to), Content: message };
    const res = await axios.post('https://smsc.hubtel.com/v1/messages/send', payload, {
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
    });
    return { success: true, data: res.data };
  } catch (err) {
    console.error('Hubtel Send Error:', err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

// ===========================================
//  DIRECT MOBILE MONEY PAYMENT
// ===========================================
app.post('/api/momo-payment', async (req, res) => {
  try {
    const { phone, amount, externalref, otpcode, ...metadata } = req.body;

    if (!phone || !amount) return res.status(400).json({ error: 'Missing phone or amount' });
    if (!MOOLRE_ACCOUNT_NUMBER || !MOOLRE_USERNAME || !MOOLRE_PUBLIC_API_KEY)
      return res.status(500).json({ error: 'Server config error' });

    const payer = cleanPhoneNumber(phone);
    const orderId = externalref || ('T' + Math.floor(Math.random() * 900000000000000 + 100000000000000));
    const channel = getChannelId(payer);

    const headers = {
      'Content-Type': 'application/json',
      'X-API-PUBKEY': MOOLRE_PUBLIC_API_KEY,
      'X-API-USER': MOOLRE_USERNAME,
    };

    const payload = {
      type: 1,
      channel,
      currency: 'GHS',
      payer,
      amount: String(Number(amount).toFixed(2)),
      externalref: orderId,
      otpcode: otpcode || '',
      reference: 'Data Purchase',
      accountnumber: MOOLRE_ACCOUNT_NUMBER,
    };

    let response;
    try {
      response = await axios.post(`${MOOLRE_BASE}/open/transact/payment`, payload, { headers });
    } catch (err) {
      const errorData = err.response?.data || err.message;
      console.error('Moolre API error:', errorData);
      return res.status(502).json({ success: false, error: 'Moolre API failed', details: errorData });
    }

    const moolreData = response.data;
    const isSuccess = moolreData.status === 1;
    const responseCode = moolreData.code;

    // STEP 1: OTP Required
    if (!otpcode && responseCode === 'TP14') {
      pendingTransactions.set(orderId, { ...payload, ...metadata });
      return res.json({ success: true, orderId, status: 'OTP_REQUIRED', message: moolreData.message });
    }

    // STEP 2: OTP submission
    if (otpcode) {
      if (isSuccess) {
        pendingTransactions.delete(orderId);
        return res.json({ success: true, orderId, status: 'VERIFIED_AND_PROMPT_SENT', message: moolreData.message });
      } else {
        return res.status(400).json({ success: false, orderId, status: 'OTP_FAILED', message: moolreData.message });
      }
    }

    // STEP 3: Direct prompt (no OTP)
    if (isSuccess) return res.json({ success: true, orderId, status: 'PROMPT_SENT', message: moolreData.message });

    console.error('Unexpected Moolre Response:', JSON.stringify(moolreData, null, 2));
    return res.status(500).json({ success: false, error: 'Unexpected Moolre response', details: moolreData });
  } catch (err) {
    console.error('Payment handler error:', err.message);
    return res.status(500).json({ error: 'Failed to process payment', details: err.message });
  }
});

// ===========================================
//  MOOLRE WEBHOOK
// ===========================================
app.post('/api/webhook/moolre', async (req, res) => {
  try {
    const payload = req.body || {};
    const data = payload.data || {};
    const incomingSecret = data.secret || payload.secret || '';

    if (incomingSecret !== MOOLRE_SECRET) return res.status(401).json({ error: 'Invalid secret' });

    const txstatus = Number(data.txstatus || 0);
    const externalref = data.externalref || '';
    if (processedOrders.has(externalref)) return res.json({ success: true, message: 'Duplicate webhook ignored' });

    processedOrders.add(externalref);
    setTimeout(() => processedOrders.delete(externalref), 60000);

    if (txstatus !== 1) return res.json({ success: true, message: 'Payment not successful' });

    const payerFromMoolre = data.payer || '';
    const metadataPhone = data.metadata?.customer_id || '';
    const customerPhone = cleanPhoneNumber(extractNumberFromPayer(payerFromMoolre, metadataPhone));

    const tempTransaction = pendingTransactions.get(externalref) || {};
    const dataPlan = tempTransaction.dataPlan || 'N/A';
    const recipient = tempTransaction.recipient || 'N/A';
    const email = tempTransaction.email || 'N/A';

    const isExpress = dataPlan.toLowerCase().includes('(express)');

    let smsText = isExpress
      ? `Your data purchase of ${dataPlan} for ${recipient} will be delivered in 5–30 minutes. Order ID: ${externalref}. Support: 233531300654`
      : `Your data purchase of ${dataPlan} for ${recipient} will be delivered in 30 min–4 hours. Order ID: ${externalref}. Support: 233531300654`;

    const smsResult = await sendHubtelSMS(customerPhone, smsText);

    const fields = {
      'Order ID': externalref,
      'Customer Phone': customerPhone,
      'Customer Email': email,
      'Data Recipient Number': recipient,
      'Data Plan': dataPlan,
      Amount: Number(data.amount || 0),
      Status: 'Pending',
      'Hubtel Sent': smsResult.success,
      'Hubtel Response': JSON.stringify(smsResult.data || smsResult.error || {}),
      'Moolre Response': JSON.stringify(payload || {}),
    };

    await airtableCreate(fields);
    console.log(`✅ Airtable Record created for Order ID: ${externalref}`);
    return res.json({ success: true, message: 'SMS sent and Airtable record created' });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(200).json({ success: false, message: 'Internal webhook error' });
  }
});

// ===========================================
//  ROUTES
// ===========================================
app.get('/', (req, res) => res.send('<h1>✅ Payconnect Moolre Backend Running</h1>'));
app.get('/api/test', (req, res) => res.json({ message: '✅ Backend live!' }));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() }));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ===========================================
//  START SERVER
// ===========================================
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
