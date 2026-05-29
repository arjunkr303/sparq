const express  = require('express');
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const supabase = require('../supabase');
const authMw   = require('../middleware/auth');
const router   = express.Router();

const rzp = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create Razorpay order (call before showing checkout)
router.post('/create-order', authMw, async (req, res) => {
  try {
    const { amount, itemId } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ message: 'Invalid amount' });

    const order = await rzp.orders.create({
      amount:   amount,        // in paise
      currency: 'INR',
      receipt:  `order_${Date.now()}`,
      notes:    { userId: req.user.id, itemId },
    });

    res.json({ orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ message: 'Payment order failed' });
  }
});

// Verify payment after checkout
router.post('/verify', authMw, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, itemId } = req.body;

    // Verify signature
    const body     = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ message: 'Payment verification failed' });
    }

    // Credit coins or activate VIP based on itemId
    const coinMap = {
      coins_50: 50,
      coins_100: 100,
      coins_200: 200,
      coins_300: 300,
      coins_500: 500,
      coins_700: 700,
      coins_1500: 1500
    };
    const { data: u } = await supabase.from('users').select('coins, is_premium').eq('id', req.user.id).maybeSingle();

    if (itemId === 'vip_monthly') {
      const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('users').update({ is_premium: true, premium_expiry: expiry, coins: (u?.coins||0) + 100 }).eq('id', req.user.id);
      res.json({ message: 'VIP activated! Enjoy your benefits.', type: 'vip' });
    } else if (itemId === 'vip_annual') {
      const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('users').update({ is_premium: true, premium_expiry: expiry, coins: (u?.coins||0) + 200 }).eq('id', req.user.id);
      res.json({ message: 'VIP Annual activated!', type: 'vip' });
    } else if (coinMap[itemId]) {
      const newCoins = (u?.coins||0) + coinMap[itemId];
      await supabase.from('users').update({ coins: newCoins }).eq('id', req.user.id);
      res.json({ message: `${coinMap[itemId]} coins added!`, coins: newCoins, type: 'coins' });
    } else {
      res.json({ message: 'Payment received', type: 'unknown' });
    }
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ message: 'Verification failed' });
  }
});

// Get active merchant UPI configuration details
router.get('/upi-config', authMw, (req, res) => {
  res.json({
    upiId: process.env.UPI_ID || 'sparq@okaxis',
    upiName: process.env.UPI_NAME || 'Sparq Chat'
  });
});

// Get active user's pending/completed manual UPI orders
router.get('/my-orders', authMw, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pending_orders')
      .select('*')
      .eq('username', req.user.username)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch pending orders error:', error);
      return res.status(500).json({ success: false, message: 'Database error fetching orders' });
    }

    res.json({ success: true, orders: data || [] });
  } catch (err) {
    console.error('Fetch my-orders catch error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper function to safely escape HTML special characters for Telegram HTML parse mode
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Helper function to send Telegram Bot alert message
async function triggerTelegramAlert(token, chatId, text) {
  if (!token || !chatId) {
    console.warn('\n⚠️  [TELEGRAM CONFIG WARNING] ⚠️');
    console.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in your environment configuration!');
    console.warn('-> If you recently added these to your .env file, you MUST RESTART your backend server process for changes to take effect.');
    console.warn('-> Make sure your .env has correct keys without quotes or extra spaces.\n');
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });
    
    if (!r.ok) {
      const errResponse = await r.json().catch(() => ({}));
      console.error('\n❌ Telegram API Error response received:');
      console.error(`Status Code: ${r.status}`);
      console.error('Payload:', JSON.stringify(errResponse, null, 2));
      console.error('Troubleshooting Steps:');
      console.error('1. Ensure your TELEGRAM_BOT_TOKEN is correct and has not expired.');
      console.error('2. IMPORTANT: You MUST start a conversation with the bot by searching for it on Telegram and clicking /start first!');
      console.error('3. Make sure the TELEGRAM_CHAT_ID is correct. For personal chats, it is a positive number. For channels/groups, it typically starts with a minus sign (e.g. -100xxxxxxxx).\n');
      return false;
    }
    return true;
  } catch (err) {
    console.error(`❌ Error sending Telegram alert request:`, err.message);
    return false;
  }
}

// Submit manual UPI payment
router.post('/submit-upi-payment', authMw, async (req, res) => {
  try {
    const { orderId, itemId, amount, itemName, transactionId } = req.body;
    if (!orderId || !itemId || !amount || !itemName || !transactionId) {
      return res.status(400).json({ success: false, message: 'Missing payment details' });
    }

    // Insert pending order in Supabase database
    const { error } = await supabase
      .from('pending_orders')
      .insert({
        order_id: orderId,
        username: req.user.username,
        email: req.user.email,
        item_purchased: itemName,
        amount: amount,
        transaction_id: transactionId,
        status: 'pending'
      });

    if (error) {
      console.error('Supabase pending order insert error:', error);
      return res.status(500).json({ success: false, message: 'Database error processing order' });
    }

    // Escape raw user/item inputs for safe Telegram HTML parsing
    const safeUsername = escapeHTML(req.user.username);
    const safeEmail = escapeHTML(req.user.email);
    const safeItemName = escapeHTML(itemName);
    const safeOrderId = escapeHTML(orderId);
    const safeTransactionId = escapeHTML(transactionId);

    // Prepare Telegram Message
    const alertMsg = `🔔 <b>New Manual UPI Payment!</b>\n\n👤 <b>User:</b> ${safeUsername}\n📧 <b>Email:</b> ${safeEmail}\n🛍️ <b>Item:</b> ${safeItemName} (₹${amount})\n🆔 <b>Order:</b> ${safeOrderId}\n🔑 <b>TXN Ref:</b> <code>${safeTransactionId}</code>\n\n👉 <i>Check GPay/PhonePe and activate in Supabase users table.</i>`;

    // Trigger alert
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const telegramSuccess = await triggerTelegramAlert(botToken, chatId, alertMsg);

    // Simulation log fallback for easy testing & local dev
    console.log('\n======================================================');
    console.log('🔔 UPI PAYMENT SUBMITTED');
    console.log('======================================================');
    console.log(`Order ID:      ${orderId}`);
    console.log(`User:          ${req.user.username} (${req.user.email})`);
    console.log(`Item:          ${itemName} (₹${amount})`);
    console.log(`TransactionID: ${transactionId}`);
    console.log('------------------------------------------------------');
    console.log('💬 Telegram Notification Sent:');
    console.log(alertMsg.replace(/<[^>]*>/g, '')); // Stripped HTML for clean console output
    console.log(`Telegram Status: ${telegramSuccess ? 'API Success ✅' : 'Failed or Skipped ❌'}`);
    console.log('======================================================\n');

    res.json({ success: true, message: 'Order submitted successfully' });
  } catch (err) {
    console.error('Submit UPI error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
