const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ====== HELPERS ======
function cleanPhoneNumber(phone) {
    // Strips all non-digit characters
    return typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
}

function extractNumberFromPayer(payerString, metadataPhone) {
    if (!payerString) return metadataPhone || '';
    // Look for number in parentheses first (e.g., MTN Mobile Money (024xxxxxxx))
    const match = payerString.match(/\(([^)]+)\)/);
    if (match && match[1]) return match[1];
    // Otherwise, return the string itself, or the metadataPhone as a fallback
    return payerString || metadataPhone || '';
}

// Helper to determine the Moolre Channel ID based on the phone number/network
function getChannelId(payerNumber) {
    const firstThree = payerNumber.substring(0, 3);
    if (firstThree.includes('24') || firstThree.includes('54') || firstThree.includes('55') || firstThree.includes('59')) return 13; // MTN
    if (firstThree.includes('20') || firstThree.includes('50')) return 6; // Vodafone/Telecel
    if (firstThree.includes('26') || firstThree.includes('56') || firstThree.includes('27') || firstThree.includes('57')) return 7; // AirtelTigo
    return 13; // Default to MTN
}

// ====== ENVIRONMENT CONFIG ======
const PORT = process.env.PORT || 3000;
const MOOLRE_BASE = process.env.MOOLRE_BASE || 'https://api.moolre.com';
const MOOLRE_PUBLIC_API_KEY = process.env.MOOLRE_PUBLIC_API_KEY || '';
const MOOLRE_USERNAME = process.env.MOOLRE_USERNAME || '';
const MOOLRE_SECRET = process.env.MOOLRE_SECRET || '';
const MOOLRE_ACCOUNT_NUMBER = process.env.MOOLRE_ACCOUNT_NUMBER || '';
const FINAL_REDIRECT_URL = 'https://ovaldataafrica.glide.page/'; // NOTE: This URL is not used in the payment flow here

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID || '';
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET || '';
const HUBTEL_SENDER = process.env.HUBTEL_SENDER || 'Pconnect';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Orders';
const BASE_URL = process.env.BASE_URL || 'https://payconnect-moolre-backend.onrender.com';

// ====== MEMORY LOCK (Prevent Duplicate Execution) ======
const processedOrders = new Set();
// Store pending transactions that are awaiting OTP submission (and temporary order metadata)
const pendingTransactions = new Map();

// --- AIRTABLE READ RECORD ---
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
        // Do not rethrow error, allow webhook to return 200 to Moolre, log the failure
        console.error('Failed to create record in Airtable.');
        return null;
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
        
        if (cleanedTo.length < 9) {
             console.warn(`Cannot send SMS: Phone number too short: ${cleanedTo}`);
             return { success: false, error: 'Invalid phone number' };
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
// NEW ENDPOINT: DIRECT MOBILE MONEY PAYMENT
// ===========================================
app.post('/api/momo-payment', async (req, res) => {
    try {
        // Collect all necessary fields from the request body
        const { phone, amount, externalref, otpcode, recipient, dataPlan, email, ...metadata } = req.body;

        if (!phone || !amount || !dataPlan) return res.status(400).json({ error: 'Missing required fields: phone, amount, dataPlan' });

        if (!MOOLRE_ACCOUNT_NUMBER || !MOOLRE_USERNAME || !MOOLRE_PUBLIC_API_KEY)
            return res.status(500).json({ error: 'Server configuration error' });

        const payer = cleanPhoneNumber(phone);
        // Reuse externalref or generate a new one
        const orderId = externalref || ('T' + Math.floor(Math.random() * 900000000000000 + 100000000000000));
        const channel = getChannelId(payer);

        const headers = {
            'Content-Type': 'application/json',
            'X-API-PUBKEY': MOOLRE_PUBLIC_API_KEY,
            'X-API-USER': MOOLRE_USERNAME,
        };

        const payload = {
            type: 1,
            channel: channel,
            currency: 'GHS',
            payer: payer,
            amount: String(Number(amount).toFixed(2)),
            externalref: orderId,
            otpcode: otpcode || '',
            reference: 'Data Purchase',
            accountnumber: MOOLRE_ACCOUNT_NUMBER,
        };
        
        // Store order details temporarily before Moolre returns the session ID
        const tempOrderData = {
            dataPlan: dataPlan,
            recipient: recipient || payer,
            email: email || 'N/A',
            payer: payer,
            amount: payload.amount,
            ...metadata
        };
        pendingTransactions.set(orderId, tempOrderData);


        let response;
        try {
            // --- STEP 1: Execute payment request (with or without OTP) ---
            if (otpcode) {
                 // STEP 2: OTP Submission - Fetch sessionid from pending transactions
                const temp = pendingTransactions.get(orderId);
                if (temp && temp.sessionid) {
                    payload.sessionid = temp.sessionid;
                } else {
                    console.error(`Session ID missing for OTP verification of Order ID: ${orderId}`);
                    return res.status(400).json({ success: false, error: 'OTP validation session missing or expired.' });
                }
            }
            
            response = await axios.post(`${MOOLRE_BASE}/open/transact/payment`, payload, { headers });
            
        } catch (err) {
            const errorData = err.response?.data || err.message;
            console.error('Moolre API error (POST /transact/payment):', errorData);
             // Clear temp data on hard failure
            pendingTransactions.delete(orderId);
            return res.status(502).json({ success: false, error: 'Moolre API request failed', details: errorData });
        }

        const moolreData = response.data;
        const responseCode = moolreData.code;

        // --- Handle Moolre Response Statuses ---

        // Case A: OTP Required (Step 1 Initial Request)
        if (!otpcode) {
            if (responseCode === 'TP14') {
                // Store sessionid for OTP verification
                const currentData = pendingTransactions.get(orderId);
                if (currentData) {
                    currentData.sessionid = moolreData.sessionid || '';
                    pendingTransactions.set(orderId, currentData);
                }
                
                console.log(`Payment started for ${orderId}. Awaiting OTP.`);
                return res.json({ success: true, orderId: orderId, status: 'OTP_REQUIRED', message: moolreData.message });
            }

            // Case B: MoMo Prompt Sent Directly (OTP not required for this transaction/network)
            if (moolreData.status === 1) { 
                // Don't delete from pendingTransactions yet, as webhook needs the metadata.
                console.log(`Payment started for ${orderId}. MoMo prompt sent directly.`);
                return res.json({ success: true, orderId: orderId, status: 'PROMPT_SENT', message: moolreData.message });
            }
        }
        
        // Case C: OTP Submission was successful (Step 2)
        if (otpcode && moolreData.status === 1) {
            // Don't delete from pendingTransactions yet, as webhook needs the metadata.
            console.log(`Payment verified for ${orderId}. Final MoMo prompt sent.`);
            return res.json({ success: true, orderId: orderId, status: 'VERIFIED_AND_PROMPT_SENT', message: moolreData.message });
        }
        
        // Case D: OTP Submission Failed (Step 2)
        if (otpcode && moolreData.status !== 1) {
            console.log(`OTP verification failed for ${orderId}. Code: ${moolreData.code}`);
             // DO NOT delete temp data yet, as user might resubmit OTP
            return res.status(400).json({ success: false, orderId: orderId, status: 'OTP_FAILED', message: moolreData.message });
        }


        // Fallback for any other unexpected Moolre response
        console.error('Unexpected Moolre Response:', JSON.stringify(moolreData, null, 2));
        // Clear temp data on unexpected failure
        pendingTransactions.delete(orderId);
        return res.status(500).json({ success: false, error: 'Unexpected Moolre response structure or failure', details: moolreData });

    } catch (err) {
        console.error('momo-payment handler error:', err.response?.data || err.message);
        return res.status(500).json({ error: 'Failed to process payment request', details: err.message });
    }
});

// ===========================================
// MOOLRE WEBHOOK (Updated)
// ===========================================
app.post('/api/webhook/moolre', async (req, res) => {
    let smsResult = { success: false, error: 'SMS not sent' };

    try {
        const payload = req.body || {};
        const data = payload.data || {};
        const incomingSecret = data.secret || payload.secret || '';

        // 1. Secret Validation
        if (incomingSecret !== MOOLRE_SECRET) {
            console.warn('Invalid webhook secret');
            return res.status(401).json({ error: 'Invalid secret' });
        }

        const txstatus = Number(data.txstatus || 0);
        const externalref = data.externalref || '';

        if (!externalref) {
            console.error('Webhook received without externalref.');
            return res.status(400).json({ success: false, message: 'Missing external reference.' });
        }

        // 2. Process Successful Transaction (txstatus = 1)
        if (txstatus === 1) {
            
            // 2a. Duplicate Check
            if (processedOrders.has(externalref)) {
                console.log(`⚠️ Duplicate webhook ignored for Order ID: ${externalref}`);
                return res.json({ success: true, message: 'Duplicate webhook ignored' });
            }
            
            // Add to processed set and set timeout to clear
            processedOrders.add(externalref);
            setTimeout(() => processedOrders.delete(externalref), 60000); // Lock for 60 seconds

            // 2b. Initialize data fields from Moolre payload
            const payerFromMoolre = data.payer || '';
            const metadataPhone = data.metadata?.customer_id || '';
            const amount = data.amount || '';
            
            // Default values
            let dataPlanWithDelivery = 'N/A - Check DB';
            let recipient = 'N/A - Check DB';
            let email = 'N/A - Check DB';
            let customerPhone = cleanPhoneNumber(extractNumberFromPayer(payerFromMoolre, metadataPhone));

            // 2c. Try to retrieve metadata from pendingTransactions map (populated in /api/momo-payment)
            const tempTransaction = pendingTransactions.get(externalref);
            if (tempTransaction) {
                dataPlanWithDelivery = tempTransaction.dataPlan || dataPlanWithDelivery;
                recipient = tempTransaction.recipient || recipient;
                email = tempTransaction.email || email;
                // If phone was stored in payload, use it
                if(tempTransaction.payer) customerPhone = cleanPhoneNumber(tempTransaction.payer);
                
                // CRUCIAL: Delete the temp data after successful webhook processing
                pendingTransactions.delete(externalref);
            }

            // 2d. Check if record already exists in Airtable (to prevent re-SMS/re-create)
            const existingRecords = await airtableRead(externalref);
            if (existingRecords && existingRecords.length > 0) {
                console.log(`✅ Transaction already processed in Airtable. Order ID: ${externalref}`);
                return res.json({ success: true, message: 'Transaction already processed.' });
            }

            // 2e. Construct SMS
            const isExpress = (dataPlanWithDelivery || '').toLowerCase().includes('(express)');
            let smsText = isExpress
                ? `Your data purchase of ${dataPlanWithDelivery} for ${recipient} has been processed and will be delivered in 5–30 minutes. Order ID: ${externalref}. For support, WhatsApp: 233531300654;`
                : `Your data purchase of ${dataPlanWithDelivery} for ${recipient} has been processed and will be delivered in 30 minutes to 4 hours. Order ID: ${externalref}. For support, WhatsApp: 233531300654;`;
            
            // 2f. Send SMS
            if (customerPhone.length >= 9) {
                smsResult = await sendHubtelSMS(customerPhone, smsText);
            } else {
                console.warn(`Cannot send SMS: Invalid customer phone number for Order ID: ${externalref}`);
            }
            
            // 2g. Create Airtable Record
            const fields = {
                'Order ID': externalref,
                'Customer Phone': customerPhone,
                'Customer Email': email,
                'Data Recipient Number': recipient,
                'Data Plan': dataPlanWithDelivery,
                Amount: Number(amount),
                Status: 'Successful', // Set status based on Moolre success
                'Hubtel Sent': smsResult.success,
                'Hubtel Response': JSON.stringify(smsResult.data || smsResult.error || {}),
                'Moolre Response': JSON.stringify(payload || {}),
            };

            await airtableCreate(fields);
            console.log(`✅ Airtable Record created for Order ID: ${externalref}`);
            
            // Return success to Moolre
            return res.json({ success: true, message: 'SMS sent and Airtable record created' });
        }

        // 3. Handle Non-Successful Transaction Status
        console.log(`Payment not successful (Status: ${txstatus}). No action taken for Order ID: ${externalref}`);
        
        // Remove temp data for failed/cancelled transactions to free up memory
        if (pendingTransactions.has(externalref)) {
            pendingTransactions.delete(externalref);
            console.log(`Cleared failed/cancelled transaction from memory: ${externalref}`);
        }
        
        return res.json({ success: true, message: 'Payment not successful' });
    } catch (err) {
        console.error('webhook handler error:', err.message);
        // Always return 200 OK for webhooks, even on internal error, to prevent Moolre from re-sending
        return res.status(200).json({ success: false, message: 'Internal processing error.' });
    }
});

// ===========================================
// OLD ENDPOINTS
// ===========================================
app.get('/', (req, res) => {
    res.send(`
        <h1>✅ Payconnect Moolre Backend</h1>
        <p>Your backend is running successfully.</p>
        <p>Try <a href="/api/test">/api/test</a> to confirm API status.</p>
    `);
});

app.get('/api/test', (req, res) => {
    res.json({ message: '✅ Payconnect Moolre backend is live!' });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
    console.log(`✅ Payconnect Moolre backend running on port ${PORT}`);
});