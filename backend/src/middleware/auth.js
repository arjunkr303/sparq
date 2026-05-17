const jwt      = require('jsonwebtoken');
const supabase = require('../supabase');

module.exports = async (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const { id } = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
    const { data: u } = await supabase.from('users')
      .select('id,username,email,gender,age,country,state,city,interests,is_verified,is_premium,coins,trust_score,is_banned')
      .eq('id', id).maybeSingle();
    if (!u) return res.status(401).json({ message: 'User not found' });
    req.user = u;
    next();
  } catch { res.status(401).json({ message: 'Invalid token' }); }
};
