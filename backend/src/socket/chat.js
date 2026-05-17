const jwt      = require('jsonwebtoken');
const supabase = require('../supabase');
const Filter   = require('bad-words');
const filter   = new Filter();

const queue  = new Map();
const chats  = new Map();
const reports= new Map();

const DEV_NAMES   = ['KING','king'];
const ADMIN_NAMES = []; // populated from DB at runtime

const norm   = s => (s || '').trim().toLowerCase();
const common = (a, b) => (a || []).filter(i => (b || []).includes(i)).length;

function genderOk(me, other) {
  if (me.gf    && me.gf    !== 'any' && other.gender !== me.gf)    return false;
  if (other.gf && other.gf !== 'any' && me.gender    !== other.gf) return false;
  return true;
}

function findMatch(me) {
  // Sort pool to prioritize boosted users first
  const pool = [...queue.values()].filter(q => q.sid !== me.sid).sort((a, b) => {
    if (a.boosted && !b.boosted) return -1;
    if (!a.boosted && b.boosted) return 1;
    return 0;
  });

  const levels = [
    // Level 0: Spotlight interest match (highest priority)
    q => (me.spotlight && q.int.includes(me.spotlight)) || (q.spotlight && me.int.includes(q.spotlight)),
    q => norm(q.city)    && norm(me.city)    && norm(q.city)    === norm(me.city)    && common(me.int, q.int) > 0,
    q => norm(q.city)    && norm(me.city)    && norm(q.city)    === norm(me.city),
    q => norm(q.state)   && norm(me.state)   && norm(q.state)   === norm(me.state)   && common(me.int, q.int) > 0,
    q => norm(q.state)   && norm(me.state)   && norm(q.state)   === norm(me.state),
    q => norm(q.country) && norm(me.country) && norm(q.country) === norm(me.country) && common(me.int, q.int) > 0,
    q => norm(q.country) && norm(me.country) && norm(q.country) === norm(me.country),
    () => true,
  ];
  for (let lvl = 0; lvl < levels.length; lvl++) {
    const m = pool.find(q => genderOk(me, q) && levels[lvl](q));
    if (m) { console.log(`✅ Level ${lvl+1}: ${me.name} <-> ${m.name}`); return m; }
  }
  return null;
}

module.exports = io => {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      socket.u = { id:null, guest:true, name:'Guest_'+Math.random().toString(36).substr(2,5), gender:'other', verified:false, premium:false, dev:false, admin:false, adminTitle:null, country:'', state:'', city:'', int:[] };
      return next();
    }
    try {
      const { id } = jwt.verify(token, process.env.JWT_SECRET);
      const { data: u } = await supabase.from('users')
        .select('id,username,gender,is_verified,is_premium,is_admin,admin_title,country,state,city,interests,is_banned,queue_boost_expiry,spotlight_interest,spotlight_expiry,chat_theme,profile_lock_expiry')
        .eq('id', id).maybeSingle();
      if (!u)          return next(new Error('User not found'));
      if (u.is_banned) return next(new Error('Banned'));
      
      const now = new Date();
      const isBoosted = u.queue_boost_expiry && new Date(u.queue_boost_expiry) > now;
      const isSpotlight = u.spotlight_expiry && new Date(u.spotlight_expiry) > now;
      const isLocked = u.profile_lock_expiry && new Date(u.profile_lock_expiry) > now;
      const hasTheme = u.theme_expiry && new Date(u.theme_expiry) > now;

      socket.u = {
        id: u.id, guest: false, name: u.username,
        gender: u.gender||'other',
        verified: u.is_verified, premium: u.is_premium,
        dev: DEV_NAMES.includes(u.username),
        admin: u.is_admin || false,
        adminTitle: u.admin_title || null,
        country: u.country||'', state: u.state||'', city: u.city||'',
        int: u.interests||[],
        boosted: isBoosted,
        spotlight: isSpotlight ? u.spotlight_interest : null,
        locked: isLocked,
        theme: hasTheme ? u.chat_theme : 'default',
      };
      next();
    } catch { next(new Error('Auth failed')); }
  });

  io.on('connection', socket => {
    const u = socket.u;
    console.log(`🔌 ${u.name} (${u.guest?'guest':'user'}) sid=${socket.id}`);

    socket.on('find_match', async ({ genderFilter } = {}) => {
      if (chats.has(socket.id)) return;
      queue.delete(socket.id);
      const me = {
        sid: socket.id, id: u.id||null, name: u.name, gender: u.gender,
        verified: u.verified, premium: u.premium, dev: u.dev,
        admin: u.admin, adminTitle: u.adminTitle,
        country: u.country, state: u.state, city: u.city,
        int: u.int, gf: genderFilter||'any', guest: u.guest,
        boosted: u.boosted, spotlight: u.spotlight, locked: u.locked, theme: u.theme,
      };
      console.log(`🔍 ${me.name} | city="${me.city}" state="${me.state}" gf="${me.gf}" queue=${queue.size}`);
      const partner = findMatch(me);
      if (partner) {
        queue.delete(partner.sid);
        const room = 'r_'+Date.now()+'_'+Math.random().toString(36).substr(2,6);
        socket.join(room);
        io.sockets.sockets.get(partner.sid)?.join(room);
        chats.set(socket.id,   { partnerId:partner.sid, roomId:room, partnerUserId: partner.id||null });
        chats.set(partner.sid, { partnerId:socket.id,   roomId:room, partnerUserId: u.id||null });
        const ci = common(me.int, partner.int);

        // Check friendship status for both sides
        let meStatus = 'none', partnerStatus = 'none';
        if (u.id && partner.id) {
          const { data: fs } = await supabase.from('friendships').select('user_id,friend_id,status')
            .or(`and(user_id.eq.${u.id},friend_id.eq.${partner.id}),and(user_id.eq.${partner.id},friend_id.eq.${u.id})`);
          if (fs && fs.length > 0) {
            const row = fs[0];
            const accepted = row.status === 'accepted';
            meStatus      = accepted ? 'friends' : (row.user_id === u.id       ? 'pending' : 'incoming');
            partnerStatus = accepted ? 'friends' : (row.user_id === partner.id ? 'pending' : 'incoming');
          }
        }

        // Get partner's live socket for fresh badge data
        const partnerSocket = io.sockets.sockets.get(partner.sid);
        const pu = partnerSocket?.u || {};

        const mkPayload = (name, gender, id, verified, premium, dev, admin, adminTitle, myStatus, locked, theme, country, state, city) => ({
          partnerUsername:   name,
          partnerGender:     gender,
          partnerVerified:   verified,
          partnerVip:        premium,
          partnerDev:        dev,
          partnerAdmin:      admin,
          partnerAdminTitle: adminTitle,
          partnerUserId:     id || null,
          commonInterests:   ci, roomId: room,
          friendshipStatus:  myStatus,
          profileLocked:     locked,
          chatTheme:         theme,
          country:           country,
          state:             state,
          city:              city,
        });

        // Current user → gets partner's info (from live partner socket.u)
        io.to(socket.id).emit('matched', mkPayload(
          pu.name    || partner.name,
          pu.gender  || partner.gender,
          pu.id      || partner.id,
          pu.verified !== undefined ? pu.verified : partner.verified,
          pu.premium  !== undefined ? pu.premium  : partner.premium,
          pu.dev      !== undefined ? pu.dev      : partner.dev,
          pu.admin    !== undefined ? pu.admin    : partner.admin,
          pu.adminTitle !== undefined ? pu.adminTitle : partner.adminTitle,
          meStatus,
          pu.locked !== undefined ? pu.locked : partner.locked,
          pu.theme || partner.theme || 'default',
          pu.country || partner.country,
          pu.state || partner.state,
          pu.city || partner.city
        ));

        // Partner → gets current user's info (from live socket.u — always fresh)
        io.to(partner.sid).emit('matched', mkPayload(
          u.name, u.gender, u.id,
          u.verified, u.premium, u.dev, u.admin, u.adminTitle,
          partnerStatus,
          u.locked, u.theme, u.country, u.state, u.city
        ));

        console.log(`🎉 ${me.name} <-> ${partner.name} room=${room} | verified: me=${u.verified} partner=${pu.verified !== undefined ? pu.verified : partner.verified}`);
      } else {
        queue.set(socket.id, me);
        socket.emit('searching', { position: queue.size });
        console.log(`⏳ ${me.name} queued. Queue=[${[...queue.values()].map(q=>q.name).join(',')}]`);
      }
    });

    socket.on('cancel_search', () => {
      queue.delete(socket.id);
      console.log(`❌ ${u.name} cancelled. Queue=${queue.size}`);
      socket.emit('search_cancelled');
    });

    socket.on('send_message', ({ message, roomId }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      let msg = message?.trim();
      if (!msg || msg.length > 500) return;
      try { msg = filter.clean(msg); } catch {}
      io.to(roomId).emit('receive_message', { from:socket.id, message:msg, timestamp:new Date().toISOString() });
    });

    // ── Image ──
    socket.on('send_image', ({ dataUrl, roomId }) => {
      if (u.guest) { socket.emit('media_error',{msg:'Sign in to send images'}); return; }
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      if (!dataUrl?.startsWith('data:image/')) return;
      if (dataUrl.length > 5*1024*1024) { socket.emit('media_error',{msg:'Image too large (max 5MB)'}); return; }
      io.to(roomId).emit('receive_image', { from:socket.id, dataUrl, timestamp:new Date().toISOString() });
    });

    // ── Voice — send as proper audio blob ──
    socket.on('send_voice', ({ dataUrl, roomId, mimeType }) => {
      if (u.guest) { socket.emit('media_error',{msg:'Sign in to send voice'}); return; }
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      if (!dataUrl?.startsWith('data:audio/')) return;
      if (dataUrl.length > 4*1024*1024) { socket.emit('media_error',{msg:'Voice too large (max 4MB)'}); return; }
      io.to(roomId).emit('receive_voice', { from:socket.id, dataUrl, mimeType: mimeType||'audio/webm', timestamp:new Date().toISOString() });
    });

    socket.on('typing', ({ roomId, isTyping }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      socket.to(roomId).emit('partner_typing', { isTyping });
    });

    socket.on('skip', () => { endChat(socket); socket.emit('skipped'); });

    // ── Friend request ──
    socket.on('send_friend_request', async ({ targetUserId }) => {
      if (u.guest || !targetUserId || !u.id) return;
      try {
        const { data: ex } = await supabase.from('friendships').select('id')
          .or(`and(user_id.eq.${u.id},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${u.id})`)
          .maybeSingle();
        if (ex) { socket.emit('friend_request_result', { success:false, message:'Already sent or friends' }); return; }
        await supabase.from('friendships').insert({ user_id: u.id, friend_id: targetUserId, status:'pending' });
        socket.emit('friend_request_result', { success:true, message:'Friend request sent!' });
        // notify partner if online
        const partnerSocket = [...io.sockets.sockets.values()].find(s => s.u?.id === targetUserId);
        if (partnerSocket) partnerSocket.emit('incoming_friend_request', { fromUsername: u.name, fromUserId: u.id });
      } catch { socket.emit('friend_request_result', { success:false, message:'Error sending request' }); }
    });

    // ── Report ──
    socket.on('report_partner', async ({ reason }) => {
      const c = chats.get(socket.id);
      if (!c) return;
      const ps = io.sockets.sockets.get(c.partnerId);
      if (!ps || ps.u?.guest) return;
      const cnt = (reports.get(c.partnerId)||0)+1;
      reports.set(c.partnerId, cnt);
      if (cnt >= 3 && ps.u?.id) {
        const { data:row } = await supabase.from('users').select('trust_score,report_count').eq('id',ps.u.id).maybeSingle();
        if (row) await supabase.from('users').update({ trust_score:Math.max(0,(row.trust_score||100)-10), report_count:(row.report_count||0)+1 }).eq('id',ps.u.id);
      }
      if (cnt >= 5 && ps.u?.id) {
        await supabase.from('users').update({ is_banned:true, ban_expiry:new Date(Date.now()+86400000).toISOString() }).eq('id',ps.u.id);
        io.to(c.partnerId).emit('banned',{message:'Suspended 24h.'});
      }
      socket.emit('report_sent');
    });

    // ── Premium Actions ──
    socket.on('send_superlike', ({ targetUserId, roomId }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      io.to(c.partnerId).emit('receive_superlike');
    });

    socket.on('send_compliment', ({ targetUserId, roomId }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      io.to(c.partnerId).emit('receive_compliment');
    });

    socket.on('disconnect', () => {
      queue.delete(socket.id);
      endChat(socket);
      console.log(`🔌 Left: ${u.name} queue=${queue.size}`);
    });

    function endChat(s) {
      const c = chats.get(s.id);
      if (!c) return;
      io.to(c.partnerId).emit('partner_disconnected');
      s.leave(c.roomId);
      io.sockets.sockets.get(c.partnerId)?.leave(c.roomId);
      chats.delete(s.id);
      chats.delete(c.partnerId);
    }
  });
};
