const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. SAFARICOM DARAJA API CREDENTIALS (CONFIGURED)
// ==========================================
const CONSUMER_KEY = 'Ft7MSVBROtRP5lSH9dKIATIZPiNebCij9a3p4PD93IzzXm07';
const CONSUMER_SECRET = 'HHfWTL2fhoC1eW9NAKRPYssbxCjB7yNGrezRVjbAF3GYRTcT5HzHmhhvN8mhxAOm';
const BUSINESS_SHORTCODE = '174379';
const PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

// LocalTunnel callback URL
const CALLBACK_URL = 'https://red-garlics-reply.loca.lt/api/mpesa-callback';

const BASE_URL = 'https://sandbox.safaricom.co.ke';

// In-memory storage for pending payments and admin ledger
const pendingPayments = {};
let ownerBalance = 0;
let proUserCount = 0;
const verifiedTransactions = [];

// Helper: Generate Safaricom OAuth Access Token
async function getAccessToken() {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    const response = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` }
    });
    return response.data.access_token;
}

// Helper: Generate YYYYMMDDHHMMSS Timestamp
function getTimestamp() {
    const date = new Date();
    return date.getFullYear() +
        ('0' + (date.getMonth() + 1)).slice(-2) +
        ('0' + date.getDate()).slice(-2) +
        ('0' + date.getHours()).slice(-2) +
        ('0' + date.getMinutes()).slice(-2) +
        ('0' + date.getSeconds()).slice(-2);
}

// Health check route
app.get('/', (req, res) => {
    res.send('Aegis SC M-Pesa Server is running properly!');
});

// Endpoint 1: Trigger STK Push
app.post('/api/stk-push', async (req, res) => {
    const { phone, amount } = req.body;

    try {
        const token = await getAccessToken();
        const timestamp = getTimestamp();
        const password = Buffer.from(`${BUSINESS_SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

        const stkResponse = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
            BusinessShortCode: BUSINESS_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount || 500,
            PartyA: phone,
            PartyB: BUSINESS_SHORTCODE,
            PhoneNumber: phone,
            CallBackURL: CALLBACK_URL,
            AccountReference: 'Aegis SC',
            TransactionDesc: 'Aegis SC Pro Upgrade'
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const checkoutRequestID = stkResponse.data.CheckoutRequestID;
        pendingPayments[checkoutRequestID] = { status: 'PENDING', phone, amount };

        res.json({
            success: true,
            checkoutRequestID: checkoutRequestID,
            message: 'STK Push initiated successfully'
        });

    } catch (error) {
        console.error('STK Push Error:', error.response ? error.response.data : error.message);
        res.status(500).json({
            success: false,
            message: error.response?.data?.errorMessage || 'Failed to initiate M-Pesa prompt. Check your LocalTunnel URL.'
        });
    }
});

// Endpoint 2: Safaricom Webhook Callback
app.post('/api/mpesa-callback', (req, res) => {
    const callbackData = req.body.Body?.stkCallback;
    if (!callbackData) return res.json({ ResultCode: 1, ResultDesc: 'Invalid payload' });

    const checkoutRequestID = callbackData.CheckoutRequestID;
    const resultCode = callbackData.ResultCode;

    if (resultCode === 0) {
        const items = callbackData.CallbackMetadata.Item;
        const receiptItem = items.find(i => i.Name === 'MpesaReceiptNumber');
        const amountItem = items.find(i => i.Name === 'Amount');
        const phoneItem = items.find(i => i.Name === 'PhoneNumber');

        const receipt = receiptItem ? receiptItem.Value : 'CONFIRMED';
        const paidAmount = amountItem ? amountItem.Value : 500;
        const payerPhone = phoneItem ? phoneItem.Value : 'M-Pesa User';

        pendingPayments[checkoutRequestID] = {
            status: 'COMPLETED',
            receipt: receipt
        };

        ownerBalance += paidAmount;
        proUserCount++;
        verifiedTransactions.unshift({
            time: new Date().toLocaleTimeString(),
            amount: paidAmount,
            source: `M-Pesa (${payerPhone}) - Ref: ${receipt}`
        });

        console.log(`Payment Verified: KES ${paidAmount} from ${payerPhone} (${receipt})`);
    } else {
        pendingPayments[checkoutRequestID] = {
            status: 'FAILED',
            reason: callbackData.ResultDesc
        };
        console.log(`Payment Failed: ${callbackData.ResultDesc}`);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Endpoint 3: Check Payment Status
app.get('/api/payment-status/:checkoutRequestID', (req, res) => {
    const payment = pendingPayments[req.params.checkoutRequestID];
    if (!payment) {
        return res.json({ status: 'NOT_FOUND' });
    }
    res.json(payment);
});

// Endpoint 4: Admin Ledger Data
app.get('/api/admin/ledger', (req, res) => {
    res.json({
        balance: ownerBalance,
        proUsers: proUserCount,
        transactions: verifiedTransactions
    });
});

// Endpoint 5: Admin Custom Withdrawal (Supports exact custom amounts)
app.post('/api/admin/withdraw', (req, res) => {
    const { method, destination, amount } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
        return res.json({ success: false, message: 'Please enter a valid withdrawal amount.' });
    }
    if (withdrawAmount > ownerBalance) {
        return res.json({ success: false, message: 'Insufficient balance for this withdrawal.' });
    }

    ownerBalance -= withdrawAmount;
    verifiedTransactions.unshift({
        time: new Date().toLocaleTimeString(),
        amount: -withdrawAmount,
        source: `Withdrawal of KES ${withdrawAmount} to ${method.toUpperCase()} (${destination})`
    });

    res.json({ 
        success: true, 
        message: `Successfully withdrew KES ${withdrawAmount} to ${destination}!`,
        newBalance: ownerBalance
    });
});

app.listen(3000, () => {
    console.log('Aegis SC M-Pesa Server running on http://localhost:3000');
});