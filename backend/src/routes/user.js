const express  = require('express');
const supabase = require('../supabase');
const authMw   = require('../middleware/auth');
const bcrypt   = require('bcryptjs');
const router   = express.Router();

const clean = u => ({
  id:           u.id,
  username:     u.username,
  email:        u.email,
  gender:       u.gender,
  age:          u.age,
  country:      u.country      || '',
  state:        u.state        || '',
  city:         u.city         || '',
  interests:    u.interests    || [],
  isVerified:   u.is_verified  || false,
  isPremium:    u.is_premium   || false,
  isAdmin:      u.is_admin     || false,
  adminTitle:   u.admin_title  || null,
  coins:        u.coins        || 0,
  twoFAEnabled: u.two_fa_enabled || false,
  memberSince:  u.created_at   || null,
  profilePhoto: u.profile_photo || null,
  trustScore:   u.trust_score  || 100,
  reportCount:  u.report_count || 0,
});

// ── get me ──
router.get('/me', authMw, async (req, res) => {
  res.json({ user: clean(req.user) });
});

// ── update profile ──
router.put('/update', authMw, async (req, res) => {
  try {
    const { username, country, state, city, interests } = req.body;
    const upd = {};
    if (country   !== undefined) upd.country   = country;
    if (state     !== undefined) upd.state     = state;
    if (city      !== undefined) upd.city      = city;
    if (interests !== undefined) upd.interests = interests;
    if (username) {
      const { data: ex } = await supabase.from('users').select('id')
        .eq('username', username).neq('id', req.user.id).maybeSingle();
      if (ex) return res.status(400).json({ message: 'Username taken' });
      upd.username = username;
    }
    const { data: u, error } = await supabase.from('users')
      .update(upd).eq('id', req.user.id).select().single();
    if (error) return res.status(500).json({ message: 'Update failed' });
    res.json({ user: clean(u) });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ── upload profile photo (base64) ──
router.post('/photo', authMw, async (req, res) => {
  try {
    const { photoBase64 } = req.body;
    if (!photoBase64) return res.status(400).json({ message: 'No photo provided' });
    // Limit size to ~800KB base64
    if (photoBase64.length > 1100000)
      return res.status(400).json({ message: 'Photo too large. Max 800KB.' });
    if (!photoBase64.startsWith('data:image/'))
      return res.status(400).json({ message: 'Invalid image format' });

    const { data: u, error } = await supabase.from('users')
      .update({ profile_photo: photoBase64 })
      .eq('id', req.user.id).select().single();
    if (error) return res.status(500).json({ message: 'Photo upload failed' });
    res.json({ user: clean(u), message: 'Photo updated!' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ── verify face ──
router.post('/verify', authMw, async (req, res) => {
  try {
    const { data: u } = await supabase.from('users')
      .update({ is_verified: true }).eq('id', req.user.id).select().single();
    res.json({ user: clean(u), message: 'Verified!' });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ── spend coins ──
router.post('/spend-coins', authMw, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ message: 'Invalid amount' });
    if ((req.user.coins || 0) < amount)
      return res.status(400).json({ message: 'Not enough coins' });
    const { data: u } = await supabase.from('users')
      .update({ coins: req.user.coins - amount }).eq('id', req.user.id).select().single();
    res.json({ user: clean(u) });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ── toggle 2FA ──
router.post('/2fa/toggle', authMw, async (req, res) => {
  try {
    const { enable, password } = req.body;
    if (!password) return res.status(400).json({ message: 'Password required' });

    const { data: u } = await supabase.from('users')
      .select('password').eq('id', req.user.id).maybeSingle();
    if (!u) return res.status(404).json({ message: 'User not found' });

    const valid = await bcrypt.compare(password, u.password);
    if (!valid) return res.status(401).json({ message: 'Wrong password' });

    const { data: updated } = await supabase.from('users')
      .update({ two_fa_enabled: !!enable }).eq('id', req.user.id).select().single();
    res.json({ user: clean(updated), message: enable ? '2FA enabled!' : '2FA disabled.' });
  } catch (err) {
    console.error('2FA toggle error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── send 2FA OTP (called from login flow) ──
router.post('/2fa/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });

    const { data: u } = await supabase.from('users').select('id, two_fa_enabled')
      .eq('email', email.toLowerCase()).maybeSingle();
    if (!u) return res.status(404).json({ message: 'User not found' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await supabase.from('users').update({ two_fa_secret: otp }).eq('id', u.id);
    console.log(`🔐 2FA OTP for ${email}: ${otp}`);

    // In production: send email via nodemailer
    // const transporter = nodemailer.createTransport({...})
    // await transporter.sendMail({ to: email, subject: 'Your OTP', text: `Your code: ${otp}` })

    res.json({
      message: 'OTP sent',
      // Only in dev — remove before going live!
      otp_dev: process.env.NODE_ENV === 'development' ? otp : undefined
    });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ message: 'Server error sending OTP' });
  }
});

// ── friends: send request ──
router.post('/friends/request', authMw, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId || targetUserId === req.user.id)
      return res.status(400).json({ message: 'Invalid target' });

    const { data: ex } = await supabase.from('friendships').select('id')
      .or(`and(user_id.eq.${req.user.id},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${req.user.id})`)
      .maybeSingle();
    if (ex) return res.status(400).json({ message: 'Already sent or already friends' });

    await supabase.from('friendships').insert({
      user_id: req.user.id, friend_id: targetUserId, status: 'pending'
    });
    res.json({ message: 'Friend request sent!' });
  } catch (err) {
    console.error('Friend request error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── friends: respond ──
router.post('/friends/respond', authMw, async (req, res) => {
  try {
    const { requestId, action } = req.body;
    const { data: fr } = await supabase.from('friendships').select('*')
      .eq('id', requestId).eq('friend_id', req.user.id).maybeSingle();
    if (!fr) return res.status(404).json({ message: 'Request not found' });

    if (action === 'accept') {
      await supabase.from('friendships').update({ status: 'accepted' }).eq('id', requestId);
      res.json({ message: 'Friend added!' });
    } else {
      await supabase.from('friendships').delete().eq('id', requestId);
      res.json({ message: 'Request rejected.' });
    }
  } catch { res.status(500).json({ message: 'Server error' }); }
});

// ── friends: list ──
router.get('/friends', authMw, async (req, res) => {
  try {
    const { data: rows } = await supabase.from('friendships')
      .select('id, status, user_id, friend_id, sender:users!friendships_user_id_fkey(id,username,is_verified,is_premium,profile_photo), receiver:users!friendships_friend_id_fkey(id,username,is_verified,is_premium,profile_photo)')
      .or(`user_id.eq.${req.user.id},friend_id.eq.${req.user.id}`);
    res.json({ friends: rows || [] });
  } catch (err) {
    console.error('Friends list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── admin: give badge ──
router.post('/admin/badge', authMw, async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ message: 'Not authorized' });
    const { targetUsername, badge } = req.body;
    const { data: target } = await supabase.from('users').select('id')
      .eq('username', targetUsername).maybeSingle();
    if (!target) return res.status(404).json({ message: 'User not found' });
    const upd = {};
    if (badge === 'admin')         upd.is_admin    = true;
    if (badge === 'verified')      upd.is_verified = true;
    if (badge === 'premium')       upd.is_premium  = true;
    if (badge === 'remove_admin')  upd.is_admin    = false;
    await supabase.from('users').update(upd).eq('id', target.id);
    res.json({ message: `Done` });
  } catch { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
