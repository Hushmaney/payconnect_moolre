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
// The redirect URL is not needed for this flow but kept for context.
const FINAL_REDIRECT_URL = 'https://ovaldataafrica.glide.page/'; 

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';
const BASE_URL = process.env.BASE_URL || 'https://payconnect-moolre-backend.onrender.com';

// ====== MEMORY LOCK (Prevent Duplicate Execution) ======
const processedOrders = new Set();
// Store pending transactions that are awaiting OTP submission
const pendingTransactions = new Map();

// Helper to determine the Moolre Channel ID based on the phone number/network
function getChannelId(payerNumber) {
    // This is a simplification. In a real app, you would determine the network
    // based on the prefix of the payerNumber (e.g., MTN, Vodafone, AirtelTigo).
    // For now, we will default to MTN (13) as an example.
    const firstThree = payerNumber.substring(0, 3);
    
    // Based on Moolre documentation: 7 - AT, 13 - MTN, 6 - Vodafone
    if (firstThree.includes('24') || firstThree.includes('54') || firstThree.includes('55')) return 13; // Example MTN
    if (firstThree.includes('20') || firstThree.includes('50')) return 6; // Example Vodafone
    if (firstThree.includes('26') || firstThree.includes('56')) return 7; // Example AirtelTigo
    
    // Default to MTN if network is undetermined, or use the most common one.
    return 13; 
}

// --- AIRTABLE READ RECORD (For Idempotency Check) ---
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

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;

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

    const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
    const payload = {
      From: HUBTEL_SENDER,
      To: cleanedTo,
      Content: message,
    };

    const res = await axios.post('https://smsc.hubtel.com/v1/messages/send', payload, {
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
    });

    return { success: true, data: res.data };
  } catch (err) {
    console.error('Hubtel send error', err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

// ===========================================
//  NEW ENDPOINT: DIRECT MOBILE MONEY PAYMENT
// ===========================================
app.post('/api/momo-payment', async (req, res) => {
  try {
    const { phone, amount, externalref, otpcode, ...metadata } = req.body;
    
    // Ensure basic required fields are present
    if (!phone || !amount) {
      return res.status(400).json({ error: 'Missing required fields: phone, amount' });
    }
    
    // Ensure Moolre credentials are set
    if (!MOOLRE_ACCOUNT_NUMBER || !MOOLRE_USERNAME || !MOOLRE_PUBLIC_API_KEY) {
      console.error('Moolre environment variables missing.');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const payer = cleanPhoneNumber(phone);
    const orderId = externalref || ('T' + Math.floor(Math.random() * 900000000000000 + 100000000000000));
    const channel = getChannelId(payer);

    const headers = {
      'Content-Type': 'application/json',
      // NOTE: Using X-API-PUBKEY for payment initiation is recommended per Moolre docs
      'X-API-PUBKEY': MOOLRE_PUBLIC_API_KEY, 
      'X-API-USER': MOOLRE_USERNAME,
    };
    
    const payload = {
      type: 1, // ID of the account status function
      channel: channel, 
      currency: 'GHS',
      payer: payer,
      amount: String(Number(amount).toFixed(2)), // Amount must be a string with 2 decimals
      externalref: orderId,
      otpcode: otpcode || '', // Pass OTP code if available
      reference: 'Data Purchase', // A fixed reference message
      accountnumber: MOOLRE_ACCOUNT_NUMBER,
      // sessionid: null, // Only used to skip OTP, not required here
    };

    let response;
    try {
      response = await axios.post(`${MOOLRE_BASE}/open/transact/payment`, payload, { headers });
    } catch (err) {
      const errorData = err.response?.data || err.message;
      console.error('Moolre API error (POST /transact/payment):', errorData);
      return res.status(502).json({ 
        success: false, 
        error: 'Moolre API request failed', 
        details: errorData 
      });
    }

    const moolreData = response.data;
    const isSuccess = moolreData.status === 1;
    const responseCode = moolreData.code;

    // --- STEP 1: INITIAL REQUEST (Trigger OTP) ---
    if (!otpcode) {
        if (responseCode === 'TP14') {
            // OTP is required and sent to the customer
            pendingTransactions.set(orderId, { ...payload, ...metadata });
            console.log(`Payment started for ${orderId}. Awaiting OTP.`);
            return res.json({ 
                success: true, 
                orderId: orderId, 
                status: 'OTP_REQUIRED', 
                message: moolreData.message
            });
        } 
        
        // If OTP is NOT required, the prompt is sent directly.
        // The Moolre status will typically be 1 (success) at this point,
        // but the final status is determined by the webhook.
        if (isSuccess) {
            console.log(`Payment started for ${orderId}. MoMo prompt sent directly.`);
            return res.json({ 
                success: true, 
                orderId: orderId, 
                status: 'PROMPT_SENT', 
                message: moolreData.message
            });
        }
    } 
    
    // --- STEP 2: OTP SUBMISSION & FINAL PROMPT ---
    if (otpcode) {
        // Successful verification and prompt sent
        if (isSuccess) {
            pendingTransactions.delete(orderId); // Clear from pending list
            console.log(`Payment verified for ${orderId}. Final MoMo prompt sent.`);
            return res.json({ 
                success: true, 
                orderId: orderId, 
                status: 'VERIFIED_AND_PROMPT_SENT', 
                message: moolreData.message
            });
        } 
        
        // Unsuccessful verification
        if (!isSuccess) {
             console.log(`OTP verification failed for ${orderId}. Code: ${responseCode}`);
             return res.status(400).json({ 
                 success: false, 
                 orderId: orderId, 
                 status: 'OTP_FAILED', 
                 message: moolreData.message 
             });
        }
    }
    
    // Catch-all for unexpected Moolre responses
    console.error('Unexpected Moolre Response:', JSON.stringify(moolreData, null, 2));
    return res.status(500).json({ 
        success: false, 
        error: 'Unexpected Moolre response structure or failure', 
        details: moolreData 
    });

  } catch (err) {
    console.error('momo-payment handler error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to process payment request', details: err.message });
  }
});


// ===========================================
//  MOOLRE WEBHOOK (No Changes Needed)
// ===========================================
app.post('/api/webhook/moolre', async (req, res) => {
  let smsResult = { success: false, error: 'SMS not sent' };

  try {
    const payload = req.body || {};
    const data = payload.data || {};
    const incomingSecret = data.secret || payload.secret || '';

    if (incomingSecret !== MOOLRE_SECRET) {
      console.warn('Invalid webhook secret');
      return res.status(401).json({ error: 'Invalid secret' });
    }

    const txstatus = Number(data.txstatus || 0);
    const externalref = data.externalref || '';
    const payerFromMoolre = data.payer || '';
    // NOTE: For the /transact/payment endpoint, metadata might not be returned in the webhook.
    // We rely on the externalref to check our local data/Airtable if needed.
    const metadataPhone = data.metadata?.customer_id || ''; 
    
    const customerPhoneRaw = extractNumberFromPayer(payerFromMoolre, metadataPhone);
    const customerPhone = cleanPhoneNumber(customerPhoneRaw);
    
    // Assuming you stored dataPlan, recipient, etc., either in Airtable on initial request 
    // or you can pull it from a temporary storage like `pendingTransactions` map if still present.
    // For now, these values will need to be re-sourced if they aren't in `data.metadata`.
    const amount = data.amount || '';
    const dataPlanWithDelivery = 'N/A - Check Airtable/DB'; // Placeholder
    const recipient = 'N/A - Check Airtable/DB'; // Placeholder
    const email = 'N/A - Check Airtable/DB'; // Placeholder
    
    // --- Temporary fix if metadata is missing in the webhook payload ---
    // In a real app, you would load this from your database using `externalref`.
    // Let's assume you store a minimal record in Airtable on Step 1.
    const tempTransaction = pendingTransactions.get(externalref);
    if(tempTransaction) {
        dataPlanWithDelivery = tempTransaction.dataPlan || dataPlanWithDelivery;
        recipient = tempTransaction.recipient || recipient;
        email = tempTransaction.email || email;
    }
    // -------------------------------------------------------------------
    
    const isExpress = dataPlanWithDelivery.toLowerCase().includes('(express)');

    // === Duplicate Protection ===
    if (processedOrders.has(externalref)) {
      console.log(`⚠️ Duplicate webhook ignored for Order ID: ${externalref}`);
      return res.json({ success: true, message: 'Duplicate webhook ignored' });
    }
    processedOrders.add(externalref);
    setTimeout(() => processedOrders.delete(externalref), 60000);

    if (txstatus === 1) {
      const existingRecords = await airtableRead(externalref);
      if (existingRecords && existingRecords.length > 0)
        return res.json({ success: true, message: 'Transaction already processed.' });

      let smsText = isExpress
        ? `Your data purchase of ${dataPlanWithDelivery} for ${recipient} has been processed and will be delivered in 5–30 minutes. Order ID: ${externalref}. For support, WhatsApp: 233531300654;`
        : `Your data purchase of ${dataPlanWithDelivery} for ${recipient} has been processed and will be delivered in 30 minutes to 4 hours. Order ID: ${externalref}. For support, WhatsApp: 233531300654;`;

      smsResult = await sendHubtelSMS(customerPhone, smsText);

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
        'Moolre Response': JSON.stringify(payload || {}),
      };

      await airtableCreate(fields);
      console.log(`✅ Airtable Record created for Order ID: ${externalref}`);
      return res.json({ success: true, message: 'SMS sent and Airtable record created' });
    }

    console.log(`Payment not successful (Status: ${txstatus}). No action taken.`);
    return res.json({ success: true, message: 'Payment not successful' });
  } catch (err) {
    console.error('webhook handler error:', err.message);
    return res.status(200).json({ success: false, message: 'Internal processing error.' });
  }
});


// ===========================================
//  OLD ENDPOINTS (Removed/Renamed)
// ===========================================

// ====== HOMEPAGE ======
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ Payconnect Moolre Backend</h1>
    <p>Your backend is running successfully.</p>
    <p>Try <a href="/api/test">/api/test</a> to confirm API status.</p>
  `);
});

// ====== TEST ROUTE ======
app.get('/api/test', (req, res) => {
  res.json({ message: '✅ Payconnect Moolre backend is live!' });
});

// ====== HEALTH CHECK (New) ======
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// ====== FALLBACK FOR UNKNOWN ROUTES ======
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`✅ Payconnect Moolre backend running on port ${PORT}`);
});