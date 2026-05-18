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
    const coinMap = { coins_50: 50, coins_200: 200, coins_500: 500, coins_1500: 1500 };
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

module.exports = router;
