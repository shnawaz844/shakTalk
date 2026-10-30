/**
 * ShakTalk Razorpay Payment Service
 * Handles order creation, hosted checkout rendering, and signature verification.
 */
const crypto = require('crypto');

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_RKlnTuK7wKads5';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'QIggZJVi5EtLhlaCkqmlq1gU';

const PLANS = {
  starter: {
    name: 'Base Plan',
    modelName: 'Gemini 2.5 Flash',
    engine: 'legacy',
    amountCents: 999, // $9.99
    currency: 'USD',
    displayPrice: '$9.99',
  },
  pro: {
    name: 'Pro Plan',
    modelName: 'Gemini 3.5 Live',
    engine: 'livekit',
    amountCents: 2499, // $24.99
    currency: 'USD',
    displayPrice: '$24.99',
  },
  business: {
    name: 'Dual AI All-Access',
    modelName: 'Dual Gemini 3.5 & 2.5',
    engine: 'livekit',
    amountCents: 4999, // $49.99
    currency: 'USD',
    displayPrice: '$49.99',
  },
};

/**
 * Creates a Razorpay Order via REST API.
 */
async function createOrder({ tier = 'pro', email, userId }) {
  const plan = PLANS[tier] || PLANS.pro;
  const authHeader = 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');

  const receipt = `shak_${tier}_${Date.now()}`.slice(0, 40);

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({
      amount: plan.amountCents,
      currency: plan.currency,
      receipt,
      notes: {
        tier,
        plan_name: plan.name,
        user_id: userId || 'anonymous',
      },
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Razorpay Order creation failed: ${data.error.description || JSON.stringify(data.error)}`);
  }

  return {
    orderId: data.id,
    amount: data.amount,
    currency: data.currency,
    tier,
    planName: plan.name,
    displayPrice: plan.displayPrice,
    keyId: RAZORPAY_KEY_ID,
  };
}

/**
 * Validates the Razorpay HMAC signature.
 */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expectedSignature === signature;
}

/**
 * Renders the hosted Razorpay Checkout page that opens in the app's browser modal.
 */
function renderCheckoutHtml({ orderId, tier = 'pro', email = 'aabir.hussain1@gmail.com', returnScheme = 'shaktalk' }) {
  const plan = PLANS[tier] || PLANS.pro;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ShakTalk Subscription Payment</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0A0D0C;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .card {
      background: #121817;
      border: 1px solid #1E2B27;
      border-radius: 24px;
      padding: 32px 24px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      background: rgba(47, 224, 168, 0.12);
      border: 1px solid rgba(47, 224, 168, 0.3);
      color: #2FE0A8;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
      text-transform: uppercase;
    }
    h1 {
      font-size: 24px;
      font-weight: 800;
      margin-bottom: 6px;
      letter-spacing: -0.3px;
    }
    .price {
      font-size: 36px;
      font-weight: 900;
      color: #2FE0A8;
      margin: 12px 0 20px;
    }
    .price span {
      font-size: 14px;
      color: rgba(255,255,255,0.5);
      font-weight: 500;
    }
    .desc {
      font-size: 13.5px;
      color: rgba(255,255,255,0.65);
      line-height: 20px;
      margin-bottom: 24px;
    }
    .btn {
      width: 100%;
      background: #2FE0A8;
      color: #000;
      border: none;
      padding: 16px;
      font-size: 16px;
      font-weight: 800;
      border-radius: 14px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .btn:active { opacity: 0.8; }
    .cancel {
      display: inline-block;
      margin-top: 18px;
      color: rgba(255,255,255,0.4);
      font-size: 13px;
      text-decoration: none;
    }
    .status-msg {
      margin-top: 16px;
      font-size: 13px;
      color: #2FE0A8;
      display: none;
    }
    .spinner {
      border: 3px solid rgba(255,255,255,0.1);
      border-top: 3px solid #2FE0A8;
      border-radius: 50%;
      width: 24px;
      height: 24px;
      animation: spin 0.8s linear infinite;
      margin: 16px auto 0;
      display: none;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">SECURE RAZORPAY CHECKOUT</div>
    <h1>${plan.name}</h1>
    <div class="price">${plan.displayPrice} <span>/ month</span></div>
    <div class="desc">Includes unlimited real-time AI live voice translation with Google Gemini.</div>

    <button id="rzp-button" class="btn">Proceed to Pay ${plan.displayPrice}</button>
    <div id="spinner" class="spinner"></div>
    <div id="status" class="status-msg">Verifying payment with bank...</div>
    <br>
    <a href="${returnScheme}://payment-cancel" class="cancel">Cancel and return to app</a>
  </div>

  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var keyId = "${RAZORPAY_KEY_ID}";
    var orderId = "${orderId}";
    var tier = "${tier}";
    var amount = ${plan.amountCents};
    var currency = "${plan.currency}";
    var returnScheme = "${returnScheme}";

    var options = {
      key: keyId,
      amount: amount,
      currency: currency,
      name: "ShakTalk",
      description: "${plan.name} Monthly Subscription",
      order_id: orderId,
      prefill: {
        email: "${email}"
      },
      theme: {
        color: "#2FE0A8"
      },
      handler: function (response) {
        document.getElementById('rzp-button').style.display = 'none';
        document.getElementById('spinner').style.display = 'block';
        document.getElementById('status').style.display = 'block';

        fetch('/payment/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: response.razorpay_order_id,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
            tier: tier
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.ok) {
            window.location.href = returnScheme + "://payment-success?status=success&tier=" + tier + "&paymentId=" + response.razorpay_payment_id;
          } else {
            alert("Payment verification failed: " + (data.error || "Please contact support."));
            window.location.href = returnScheme + "://payment-cancel";
          }
        })
        .catch(function(err) {
          window.location.href = returnScheme + "://payment-success?status=success&tier=" + tier + "&paymentId=" + response.razorpay_payment_id;
        });
      },
      modal: {
        ondismiss: function() {
          console.log("Checkout modal closed");
        }
      }
    };

    var rzp = new Razorpay(options);

    document.getElementById('rzp-button').onclick = function(e) {
      rzp.open();
      e.preventDefault();
    };

    // Auto-launch checkout when page loads
    window.addEventListener('load', function() {
      setTimeout(function() {
        try { rzp.open(); } catch(e) {}
      }, 300);
    });
  </script>
</body>
</html>`;
}

module.exports = {
  createOrder,
  verifyPaymentSignature,
  renderCheckoutHtml,
  PLANS,
  RAZORPAY_KEY_ID,
};

