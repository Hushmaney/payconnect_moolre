require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Config from env
const PORT = process.env.PORT || 3000;
const MOORLE_BASE = process.env.MOORLE_BASE || 'https://api.moolre.com';
const MOORLE_PUBLIC_API_KEY = process.env.MOORLE_PUBLIC_API_KEY || '';
const MOORLE_PRIVATE_API_KEY = process.env.MOORLE_PRIVATE_API_KEY || '';
const MOORLE_SECRET = process.env.MOORLE_SECRET || '';

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';

// Helper: Airtable create
async function airtableCreate(fields){
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  const res = await axios.post(url, { fields }, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } });
  return res.data;
}

// Helper: Airtable update
async function airtableUpdate(recordId, fields){
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
  const res = await axios.patch(url, { fields }, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } });
  return res.data;
}

// Helper: find by ExternalRef or Order ID
async function airtableFindByOrderId(orderId){
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=({Order ID}='${orderId}')`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  return res.data.records && res.data.records.length ? res.data.records[0] : null;
}

// Send Hubtel SMS (basic BasicAuth). Adjust if Hubtel requires different flow.
async function sendHubtelSMS(to, message){
  if(!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET){
    console.warn('Hubtel credentials missing; skipping SMS.');
    return { success: false, error: 'no-credentials' };
  }
  const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
  const payload = { From: HUBTEL_SENDER, To: to, Content: message, ClientId: HUBTEL_CLIENT_ID };
  try{
    const res = await axios.post('https://api.hubtel.com/v1/messages', payload, {
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' }
    });
    return { success: true, data: res.data };
  }catch(err){
    console.error('Hubtel send error', err.response?.data || err.message || err);
    return { success: false, error: err.response?.data || err.message };
  }
}

// Start checkout: creates Airtable order and returns Moorle payment link
app.post('/api/start-checkout', async (req, res) => {
  try{
    const { email, phone, recipient, network, deliveryType, dataPlan, amount, orderId } = req.body;
    const providedOrderId = orderId || ('T' + Math.floor(Math.random()*900000000000000 + 100000000000000));
    if(!phone || !recipient || !network || !dataPlan || !amount){
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create Airtable record with Status = Pending and Hubtel Sent = No initially
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

    // Call Moorle to create payment
    const payload = {
      accountstatus: 1,
      channel: 13,
      currency: 'GHS',
      payer: phone,
      amount: Number(amount).toFixed(2),
      externalref: providedOrderId,
      description: `PAYCONNECT: ${dataPlan} for ${recipient}`
    };
    const headers = { 'Content-Type': 'application/json', 'x-api-key': MOORLE_PUBLIC_API_KEY || '' };

    const mRes = await axios.post(`${MOORLE_BASE}/open/transact/payment`, payload, { headers });
    const mData = mRes.data || {};

    // Attempt to derive a payment link
    const paymentLink = mData.data?.payment_link || mData.data?.paymentLink || mData.data?.redirect_url || mData.data?.redirectUrl || null;

    // Update Airtable with Moorle raw response if possible
    try{
      await airtableUpdate(airtableId, { "Moolre Response": JSON.stringify(mData) });
    }catch(err){
      console.warn('Failed to update Airtable with Moorle response', err.message || err);
    }

    return res.json({ success: true, data: { airtableId, orderId: providedOrderId, paymentLink, moorle: mData } });
  }catch(err){
    console.error('start-checkout error', err.response?.data || err.message || err);
    return res.status(500).json({ error: 'Failed to start checkout', details: err.response?.data || err.message || '' });
  }
});

// Moorle webhook endpoint
app.post('/api/webhook/moorle', async (req, res) => {
  try{
    const payload = req.body || {};
    const data = payload.data || {};

    // Validate secret
    const incomingSecret = data.secret || payload.secret || '';
    if(!MOORLE_SECRET){
      console.warn('MOORLE_SECRET not configured on server. Rejecting webhook for safety.');
      return res.status(401).json({ error: 'Webhook secret not configured' });
    }
    if(incomingSecret !== MOORLE_SECRET){
      console.warn('Invalid webhook secret', incomingSecret);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    // Extract transaction details
    const txstatus = Number(data.txstatus || 0); // 1 = success, 0 pending, 2 failed
    const externalref = data.externalref || data.externalRef || '';
    const payer = data.payer || payload.payer || '';
    const amount = data.amount || data.value || '';

    // Find Airtable record by Order ID (externalref)
    const record = await airtableFindByOrderId(externalref);
    if(!record){
      console.warn('Airtable record not found for externalref/orderId', externalref);
      return res.json({ success: true, message: 'record-not-found' });
    }
    const airtableId = record.id;

    // On success: keep Status = Pending (admin will fulfil), set Hubtel Sent = Yes after SMS
    if(txstatus === 1){
      // Prepare message depending on delivery type
      const delivery = record.fields['Delivery Type'] || record.fields['DeliveryType'] || 'Normal';
      const dataPlan = record.fields['Data Plan'] || '';
      const recipient = record.fields['Data Recipient Number'] || '';
      const orderId = record.fields['Order ID'] || externalref;
      const deliveryText = (delivery === 'Express') ? '5-30 minutes' : '30 minutes to 4 hours';

      const sms = `Your data purchase of ${dataPlan} for ${recipient} has been processed and will be delivered in ${deliveryText}. Order ID: ${orderId}. For support, WhatsApp: 233531300654`;

      // Send SMS
      const smsResult = await sendHubtelSMS(payer || record.fields['Customer Phone'] || recipient, sms);

      // Update Airtable: keep Status Pending, set Hubtel Sent based on result, store Moolre webhook payload
      const updateFields = {
        "Status": "Pending",
        "Hubtel Sent": smsResult && smsResult.success ? "Yes" : "No",
        "Moolre Response": JSON.stringify(payload)
      };
      await airtableUpdate(airtableId, updateFields);

      return res.json({ success: true });
    } else {
      // not successful
      await airtableUpdate(airtableId, { "Moolre Response": JSON.stringify(payload), "Hubtel Sent": "No" });
      return res.json({ success: true });
    }
  }catch(err){
    console.error('webhook handler error', err.response?.data || err.message || err);
    return res.status(500).json({ error: 'webhook handler internal error' });
  }
});

app.listen(PORT, ()=> {
  console.log(`Payconnect Moorle backend running on port ${PORT}`);
});
