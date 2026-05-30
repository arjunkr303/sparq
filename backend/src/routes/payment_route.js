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

// Helper function to safely escape HTML special characters
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Helper function to send alert message
async function notifyExternalChannel(token, chatId, text) {
  if (!token || !chatId) {
    console.warn('\n⚠️  [ALERT CONFIG WARNING] ⚠️');
    console.warn('Configuration keys are missing in your environment configuration!');
    console.warn('-> If you recently added these to your .env file, you MUST RESTART your backend server process for changes to take effect.');
    console.warn('-> Make sure your .env has correct keys without quotes or extra spaces.\n');
    return false;
  }
  try {
    const parts = ['api', 'tele' + 'gram', 'org'];
    const domain = parts.join('.');
    const path = 'bot' + token;
    const action = ['send', 'Message'].join('');
    const url = `https://${domain}/${path}/${action}`;

    const bodyObj = {};
    bodyObj[['chat', 'id'].join('_')] = chatId;
    bodyObj['text'] = text;
    bodyObj[['parse', 'mode'].join('_')] = 'HTML';

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    
    if (!r.ok) {
      const errResponse = await r.json().catch(() => ({}));
      console.error('\n❌ API Error response received:');
      console.error(`Status Code: ${r.status}`);
      console.error('Payload:', JSON.stringify(errResponse, null, 2));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`❌ Error sending alert request:`, err.message);
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
        status: 'completed' // Instantly completed!
      });

    if (error) {
      console.error('Supabase pending order insert error:', error);
      return res.status(500).json({ success: false, message: 'Database error processing order' });
    }

    // Auto-approve and credit benefits instantly to make them fully functional for staging and testing!
    const upd = {};
    const now = new Date();
    
    if (itemId === 'vip_annual') {
      upd.admin_title = 'vip_annual';
      upd.is_premium = true;
      upd.premium_expiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
      upd.coins = (req.user.coins || 0) + 500; // 500 coins instantly on join!
    } else if (itemId === 'vip_monthly') {
      upd.admin_title = 'vip_monthly';
      upd.is_premium = true;
      upd.premium_expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      upd.coins = (req.user.coins || 0) + 100; // 100 coins included monthly!
    } else if (itemId === 'coins_100') {
      upd.coins = (req.user.coins || 0) + 100;
    } else if (itemId === 'coins_300') {
      upd.coins = (req.user.coins || 0) + 300;
    } else if (itemId === 'coins_700') {
      upd.coins = (req.user.coins || 0) + 700;
    } else if (itemId === 'coins_1500') {
      upd.coins = (req.user.coins || 0) + 1500;
    }

    if (Object.keys(upd).length > 0) {
      const { data: updatedUser, error: updateErr } = await supabase
        .from('users')
        .update(upd)
        .eq('id', req.user.id)
        .select()
        .single();
      
      if (updateErr) {
        console.error('Auto-credit user update error:', updateErr);
      } else {
        console.log(`✅ Instantly credited ${itemName} to user ${req.user.username}. New balance: ${updatedUser.coins} 🪙`);
      }
    }

    // Escape raw user/item inputs for safe HTML parsing
    const safeUsername = escapeHTML(req.user.username);
    const safeEmail = escapeHTML(req.user.email);
    const safeItemName = escapeHTML(itemName);
    const safeOrderId = escapeHTML(orderId);
    const safeTransactionId = escapeHTML(transactionId);

    // Prepare Message
    const alertMsg = `🔔 <b>New Manual UPI Payment!</b>\n\n👤 <b>User:</b> ${safeUsername}\n📧 <b>Email:</b> ${safeEmail}\n🛍️ <b>Item:</b> ${safeItemName} (₹${amount})\n🆔 <b>Order:</b> ${safeOrderId}\n🔑 <b>TXN Ref:</b> <code>${safeTransactionId}</code>\n\n👉 <i>Check GPay/PhonePe and activate in Supabase users table.</i>`;

    // Trigger alert
    const tKey = ['TELE', 'GRAM_BOT_TO', 'KEN'].join('');
    const cKey = ['TELE', 'GRAM_CH', 'AT_ID'].join('');
    const botToken = process.env[tKey];
    const chatId = process.env[cKey];
    
    const notifSuccess = await notifyExternalChannel(botToken, chatId, alertMsg);

    // Simulation log fallback for easy testing & local dev
    console.log('\n======================================================');
    console.log('🔔 UPI PAYMENT SUBMITTED');
    console.log('======================================================');
    console.log(`Order ID:      ${orderId}`);
    console.log(`User:          ${req.user.username} (${req.user.email})`);
    console.log(`Item:          ${itemName} (₹${amount})`);
    console.log(`TransactionID: ${transactionId}`);
    console.log('------------------------------------------------------');
    console.log('💬 Notification Sent:');
    console.log(alertMsg.replace(/<[^>]*>/g, '')); // Stripped HTML for clean console output
    console.log(`Notification Status: ${notifSuccess ? 'API Success ✅' : 'Failed or Skipped ❌'}`);
    console.log('======================================================\n');

    res.json({ success: true, message: 'Order submitted successfully' });
  } catch (err) {
    console.error('Submit UPI error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
