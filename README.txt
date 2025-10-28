PAYCONNECT - SAFE Deploy Package (no secrets included)
=====================================================

Contents:
- frontend/index.html    -> Drop this folder into Netlify (drag & drop) as a site.
- backend/               -> Deploy this folder to Render as a Web Service named: payconnect-moolre-backend
                          (or any name; adjust frontend BACKEND_URL if you change the domain)

Important: This package **does not** include real API secrets. Fill them in Render's environment variables using the .env.example keys.

ENVIRONMENT VARIABLES (set these in Render)
--------------------------------------------
MOORLE_BASE=https://api.moolre.com
MOORLE_PUBLIC_API_KEY=...
MOORLE_PRIVATE_API_KEY=...
MOORLE_SECRET=...           # required — used to verify authentic Moorle webhooks

HUBTEL_CLIENT_ID=...
HUBTEL_CLIENT_SECRET=...
HUBTEL_SENDER=Pconnect

AIRTABLE_API_KEY=...
AIRTABLE_BASE=...
AIRTABLE_TABLE=Orders

Deploy Backend to Render
------------------------
1. Create a new Web Service on Render:
   - Name: payconnect-moolre-backend
   - Environment: Node
   - Build command: (none)
   - Start command: `node server.js`
   - Drag & drop the `backend` folder or connect your repo

2. In the Render dashboard, open your service -> Environment -> add the variables listed above.
3. Deploy the service. Render will assign a URL like:
   `https://payconnect-moolre-backend.onrender.com`
   If you use that exact name when creating the service, the frontend already points to it.

Deploy Frontend to Netlify
-------------------------
1. Create a new site on Netlify -> Drag & drop -> upload the `frontend` folder.
2. The site will be live. The checkout page is preconfigured to post to:
   https://payconnect-moolre-backend.onrender.com/api/start-checkout

Testing the Flow
----------------
1. Open the frontend on Netlify, fill the form and click Pay.
2. The frontend will POST to /api/start-checkout, which creates an Airtable record (Status=Pending) and calls Moorle to create a payment.
3. Moorle will return a payment link; user is redirected to Moorle to complete payment.
4. Configure Moorle to call your webhook URL:
   `https://<your-render-domain>/api/webhook/moorle`
   Moorle will POST a JSON similar to the example you shared.
5. The backend verifies `data.secret` against MOORLE_SECRET:
   - If it matches and txstatus==1, backend sends SMS via Hubtel and updates Airtable:
     - Status: Pending (admin will fulfill)
     - Hubtel Sent: Yes (or No if SMS failed)
     - Moolre Response: (raw JSON payload)
6. Admin manually processes the order in Airtable.

Notes & Next Steps
------------------
- Hubtel: this code uses Basic auth. If your Hubtel account requires OAuth or other flow, update the sendHubtelSMS function accordingly.
- Moorle: verify channel IDs and payload fields if your account uses different parameters.
- Security: keep secrets in Render environment variables (do not commit .env).
