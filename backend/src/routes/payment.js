const express  = require('express');
const supabase = require('../supabase');
const authMw   = require('../middleware/auth');
const router   = express.Router();

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
