const jwt = require("jsonwebtoken");
const supabase = require("../supabase");
const { tryClaim } = require("../openerRooms");
const Filter = require("bad-words");
const filter = new Filter();

const queue = new Map();
const chats = new Map();
const reports = new Map();
// pendingUndoQueue: targetUserId → { requesterSid, requesterUserId, timer }
const pendingUndoQueue = new Map();

const DEV_NAMES = ["KING", "king"];
const DEV_EMAILS = ["arjunsreechakram@gmail.com", "jithubaiju124@gmail.com"];
const ADMIN_NAMES = []; // populated from DB at runtime

const norm = (s) => (s || "").trim().toLowerCase();
const common = (a, b) => (a || []).filter((i) => (b || []).includes(i)).length;
const sharedNames = (a, b) => {
  const bs = new Set((b || []).map(norm));
  return (a || []).filter((i) => bs.has(norm(i)));
};

function genderOk(me, other) {
  if (me.gf && me.gf !== "any" && other.gender !== me.gf) return false;
  if (other.gf && other.gf !== "any" && me.gender !== other.gf) return false;
  return true;
}

/** VIP only: city → state → country (with optional shared tags). */
const locationLevels = (me) => [
  (q) =>
    norm(q.city) &&
    norm(me.city) &&
    norm(q.city) === norm(me.city) &&
    common(me.int, q.int) > 0,
  (q) => norm(q.city) && norm(me.city) && norm(q.city) === norm(me.city),
  (q) =>
    norm(q.state) &&
    norm(me.state) &&
    norm(q.state) === norm(me.state) &&
    common(me.int, q.int) > 0,
  (q) => norm(q.state) && norm(me.state) && norm(q.state) === norm(me.state),
  (q) =>
    norm(q.country) &&
    norm(me.country) &&
    norm(q.country) === norm(me.country) &&
    common(me.int, q.int) > 0,
  (q) =>
    norm(q.country) && norm(me.country) && norm(q.country) === norm(me.country),
];

/** Free users: match by shared interest tags only (no location). */
const tagLevels = (me) => [(q) => common(me.int, q.int) > 0];

function findMatch(me) {
  const pool = [...queue.values()]
    .filter((q) => q.sid !== me.sid)
    .sort((a, b) => {
      if (a.boosted && !b.boosted) return -1;
      if (!a.boosted && b.boosted) return 1;
      return 0;
    });

  const levels = me.premium
    ? [
      ...locationLevels(me),
      ...tagLevels(me),
      () => true,
    ]
    : [...tagLevels(me), () => true];

  const mode = me.premium ? "location" : "interests";
  for (let lvl = 0; lvl < levels.length; lvl++) {
    const m = pool.find((q) => genderOk(me, q) && levels[lvl](q));
    if (m) {
      console.log(
        `✅ ${mode} L${lvl + 1}: ${me.name} <-> ${m.name}${me.premium ? "" : " (tags)"}`,
      );
      return m;
    }
  }
  return null;
}

module.exports = (io) => {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      socket.u = {
        id: null,
        guest: true,
        name: "Guest_" + Math.random().toString(36).substr(2, 5),
        gender: "other",
        verified: false,
        premium: false,
        dev: false,
        admin: false,
        adminTitle: null,
        country: "",
        state: "",
        city: "",
        int: [],
      };
      return next();
    }
    try {
      const { id } = jwt.verify(token, process.env.JWT_SECRET);
      const { data: u } = await supabase
        .from("users")
        .select(
          "id,username,email,gender,is_verified,is_premium,premium_expiry,is_admin,admin_title,country,state,city,interests,is_banned,queue_boost_expiry,chat_theme,theme_expiry,profile_lock_expiry,aura_expiry,profile_photo",
        )
        .eq("id", id)
        .maybeSingle();
      if (!u) return next(new Error("User not found"));
      if (u.is_banned) return next(new Error("Banned"));

      // Enable dynamic VIP / Premium status while keeping verified check simple
      u.is_verified = true;

      const isDevEmail = u.email && DEV_EMAILS.includes(u.email.toLowerCase());
      const now = new Date();
      const isBoosted =
        isDevEmail || (u.queue_boost_expiry && new Date(u.queue_boost_expiry) > now);
      const isLocked =
        isDevEmail || (u.profile_lock_expiry && new Date(u.profile_lock_expiry) > now);
      const hasTheme = isDevEmail || (u.theme_expiry && new Date(u.theme_expiry) > now);
      const isPremiumAnnual =
        isDevEmail || u.admin_title === 'vip_annual';
      const isPremium =
        isDevEmail || !!(u.is_premium && u.premium_expiry && new Date(u.premium_expiry) > now) || u.admin_title === 'vip_monthly' || u.admin_title === 'vip_annual';
      const hasAura = isDevEmail || (u.aura_expiry && new Date(u.aura_expiry) > now);

      socket.u = {
        id: u.id,
        guest: false,
        name: u.username,
        gender: u.gender || "other",
        verified: isDevEmail || u.is_verified,
        premium: !!isPremium,
        premiumAnnual: !!isPremiumAnnual,
        dev: isDevEmail || DEV_NAMES.includes(u.username),
        admin: isDevEmail || u.is_admin || false,
        adminTitle: isDevEmail ? "Developer" : (u.admin_title || null),
        country: u.country || "",
        state: u.state || "",
        city: u.city || "",
        int: u.interests || [],
        boosted: isBoosted,
        spotlight: null,
        locked: isLocked,
        theme: isDevEmail ? (u.chat_theme || "premium") : (hasTheme ? u.chat_theme : "default"),
        aura: hasAura,
        profilePhoto: u.profile_photo || null,
      };
      next();
    } catch {
      next(new Error("Auth failed"));
    }
  });

  io.on("connection", (socket) => {
    const u = socket.u;
    console.log(
      `🔌 ${u.name} (${u.guest ? "guest" : "user"}) sid=${socket.id}`,
    );

    if (!u.guest && u.id) {
      supabase
        .from("friendships")
        .select("id")
        .or(`user_id.eq.${u.id},friend_id.eq.${u.id}`)
        .eq("status", "accepted")
        .then(({ data: fr }) => {
          if (fr) {
            fr.forEach((f) => {
              const roomName = `f_${f.id}`;
              socket.join(roomName);
              socket.to(roomName).emit("partner_status", { online: true });
            });
          }
        })
        .catch((err) => {
          console.error("error joining friend rooms on connect:", err);
        });
    }

    socket.on("find_match", async ({ genderFilter } = {}) => {
      if (chats.has(socket.id)) return;
      queue.delete(socket.id);
      const me = {
        sid: socket.id,
        id: u.id || null,
        name: u.name,
        gender: u.gender,
        verified: u.verified,
        premium: u.premium,
        premiumAnnual: u.premiumAnnual,
        dev: u.dev,
        admin: u.admin,
        adminTitle: u.adminTitle,
        country: u.country,
        state: u.state,
        city: u.city,
        int: u.int,
        gf: genderFilter || "any",
        boosted: u.boosted,
        spotlight: u.spotlight,
        locked: u.locked,
        theme: u.theme,
        aura: u.aura,
        profilePhoto: u.profilePhoto || null,
      };
      console.log(
        `🔍 ${me.name} | mode=${me.premium ? "VIP-location" : "tags"} city="${me.city}" gf="${me.gf}" queue=${queue.size}`,
      );
      const partner = findMatch(me);
      if (partner) {
        queue.delete(partner.sid);
        const room =
          "r_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
        socket.join(room);
        io.sockets.sockets.get(partner.sid)?.join(room);
        chats.set(socket.id, {
          partnerId: partner.sid,
          roomId: room,
          partnerUserId: partner.id || null,
        });
        chats.set(partner.sid, {
          partnerId: socket.id,
          roomId: room,
          partnerUserId: u.id || null,
        });
        const ci = common(me.int, partner.int);
        const sharedList = sharedNames(me.int, partner.int);

        // Check friendship status for both sides
        let meStatus = "none",
          partnerStatus = "none";
        if (u.id && partner.id) {
          const { data: fs } = await supabase
            .from("friendships")
            .select("user_id,friend_id,status")
            .or(
              `and(user_id.eq.${u.id},friend_id.eq.${partner.id}),and(user_id.eq.${partner.id},friend_id.eq.${u.id})`,
            );
          if (fs && fs.length > 0) {
            const row = fs[0];
            const accepted = row.status === "accepted";
            meStatus = accepted
              ? "friends"
              : row.user_id === u.id
                ? "pending"
                : "incoming";
            partnerStatus = accepted
              ? "friends"
              : row.user_id === partner.id
                ? "pending"
                : "incoming";
          }
        }

        // Get partner's live socket for fresh badge data
        const partnerSocket = io.sockets.sockets.get(partner.sid);
        const pu = partnerSocket?.u || {};

        const mkPayload = (
          name,
          gender,
          id,
          verified,
          premium,
          premiumAnnual,
          dev,
          admin,
          adminTitle,
          myStatus,
          locked,
          theme,
          country,
          state,
          city,
          interests,
          aura,
          profilePhoto,
        ) => ({
          partnerUsername: name,
          partnerGender: gender,
          partnerVerified: verified,
          partnerVip: premium,
          partnerVipAnnual: premiumAnnual,
          partnerDev: dev,
          partnerAdmin: admin,
          partnerAdminTitle: adminTitle,
          partnerUserId: id || null,
          commonInterests: ci,
          roomId: room,
          sharedInterestNames: sharedList,
          friendshipStatus: myStatus,
          profileLocked: locked,
          chatTheme: theme,
          country: country,
          state: state,
          city: city,
          partnerInterests: interests || [],
          partnerAura: aura || false,
          partnerProfilePhoto: locked ? null : profilePhoto || null,
        });

        // Current user → gets partner's info (from live partner socket.u)
        io.to(socket.id).emit(
          "matched",
          mkPayload(
            pu.name || partner.name,
            pu.gender || partner.gender,
            pu.id || partner.id,
            pu.verified !== undefined ? pu.verified : partner.verified,
            pu.premium !== undefined ? pu.premium : partner.premium,
            pu.premiumAnnual !== undefined
              ? pu.premiumAnnual
              : partner.premiumAnnual,
            pu.dev !== undefined ? pu.dev : partner.dev,
            pu.admin !== undefined ? pu.admin : partner.admin,
            pu.adminTitle !== undefined ? pu.adminTitle : partner.adminTitle,
            meStatus,
            pu.locked !== undefined ? pu.locked : partner.locked,
            pu.theme || partner.theme || "default",
            pu.country || partner.country,
            pu.state || partner.state,
            pu.city || partner.city,
            pu.int || partner.int || [],
            pu.aura !== undefined ? pu.aura : partner.aura,
            pu.profilePhoto || partner.profilePhoto || null,
          ),
        );

        // Partner → gets current user's info (from live socket.u — always fresh)
        io.to(partner.sid).emit(
          "matched",
          mkPayload(
            u.name,
            u.gender,
            u.id,
            u.verified,
            u.premium,
            u.premiumAnnual,
            u.dev,
            u.admin,
            u.adminTitle,
            partnerStatus,
            u.locked,
            u.theme,
            u.country,
            u.state,
            u.city,
            u.int || [],
            u.aura,
            u.profilePhoto || null,
          ),
        );

        console.log(
          `🎉 ${me.name} <-> ${partner.name} room=${room} | verified: me=${u.verified} partner=${pu.verified !== undefined ? pu.verified : partner.verified}`,
        );
      } else {
        queue.set(socket.id, me);
        socket.emit("searching", {
          position: queue.size,
          matchMode: me.premium ? "location" : "interests",
        });
        console.log(
          `⏳ ${me.name} queued. Queue=[${[...queue.values()].map((q) => q.name).join(",")}]`,
        );
      }
    });

    socket.on("cancel_search", () => {
      queue.delete(socket.id);
      console.log(`❌ ${u.name} cancelled. Queue=${queue.size}`);
      socket.emit("search_cancelled");
    });

    socket.on("cancel_undo_wait", () => {
      // Remove this socket from any pending undo wait entry it created
      for (const [tuid, entry] of pendingUndoQueue.entries()) {
        if (entry.requesterSid === socket.id) {
          clearTimeout(entry.timer);
          pendingUndoQueue.delete(tuid);
          console.log(`❌ ${u.name} cancelled undo-wait for userId=${tuid}`);
        }
      }
    });

    socket.on("init_dashboard", async () => {
      if (u.guest || !u.id) return;
      try {
        const { data: fr } = await supabase
          .from("friendships")
          .select("id")
          .or(`user_id.eq.${u.id},friend_id.eq.${u.id}`)
          .eq("status", "accepted");
        if (fr) {
          fr.forEach((f) => {
            const roomName = `f_${f.id}`;
            socket.join(roomName);
            // Optionally, tell others we are "online" when dashboard is open
            socket.to(roomName).emit("partner_status", { online: true });
          });
        }
      } catch (err) {
        console.error("init_dashboard error:", err);
      }
    });

    socket.on("join_friend_chat", async ({ friendshipId }, callback) => {
      if (u.guest || !u.id || !friendshipId) {
        if (callback) callback({ success: false, message: "Invalid request" });
        return;
      }
      try {
        const { data: fr } = await supabase
          .from("friendships")
          .select("id, user_id, friend_id, status")
          .eq("id", friendshipId)
          .maybeSingle();

        if (!fr || fr.status !== "accepted") {
          if (callback) callback({ success: false, message: "Friendship not accepted" });
          return;
        }

        if (fr.user_id !== u.id && fr.friend_id !== u.id) {
          if (callback) callback({ success: false, message: "Unauthorized" });
          return;
        }

        const roomName = `f_${friendshipId}`;
        socket.join(roomName);

        // Check if partner is online in this room
        const clients = io.sockets.adapter.rooms.get(roomName);
        const numClients = clients ? clients.size : 0;
        const partnerOnline = numClients > 1;

        // Broadcast to room that user is online in the friend chat
        socket.to(roomName).emit("partner_status", { online: true });

        if (callback) callback({ success: true, partnerOnline });
      } catch (err) {
        console.error("join_friend_chat error:", err);
        if (callback) callback({ success: false, message: "Server error" });
      }
    });

    socket.on("send_message", async ({ message, roomId, replyTo, messageId }) => {
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      if (roomId && !roomId.startsWith("f_")) {
        tryClaim(roomId);
        const c = chats.get(socket.id);
        if (c && c.partnerId) {
          io.to(c.partnerId).emit("opener_used");
          socket.emit("opener_used");
        }
      }

      let msg = message?.trim();
      if (!msg || msg.length > 500) return;
      try {
        msg = filter.clean(msg);
      } catch { }
      const msgId = messageId || ("msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9));

      if (roomId && roomId.startsWith("f_")) {
        const friendshipId = roomId.substring(2);
        try {
          await supabase.from("friend_messages").insert({
            friendship_id: friendshipId,
            sender_id: u.id,
            content: msg,
            type: "text",
            reply_to: replyTo || null,
            message_id: msgId,
            seen: false
          });
        } catch (err) {
          console.error("Error saving friend message:", err);
        }
      }

      io.to(roomId).emit("receive_message", {
        from: socket.id,
        fromUserId: u.id,
        roomId: roomId,
        message: msg,
        timestamp: new Date().toISOString(),
        replyTo: replyTo || null,
        messageId: msgId,
      });
    });

    // ── Image ──
    socket.on("send_image", async ({ dataUrl, roomId, replyTo, messageId }) => {
      if (u.guest) {
        socket.emit("media_error", { msg: "Sign in to send images" });
        return;
      }
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      if (roomId && !roomId.startsWith("f_")) {
        tryClaim(roomId);
        const c = chats.get(socket.id);
        if (c && c.partnerId) {
          io.to(c.partnerId).emit("opener_used");
          socket.emit("opener_used");
        }
      }

      if (!dataUrl?.startsWith("data:image/")) return;
      if (dataUrl.length > 5 * 1024 * 1024) {
        socket.emit("media_error", { msg: "Image too large (max 5MB)" });
        return;
      }
      const msgId = messageId || ("msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9));

      if (roomId && roomId.startsWith("f_")) {
        const friendshipId = roomId.substring(2);
        try {
          await supabase.from("friend_messages").insert({
            friendship_id: friendshipId,
            sender_id: u.id,
            content: dataUrl,
            type: "image",
            reply_to: replyTo || null,
            message_id: msgId,
            seen: false
          });
        } catch (err) {
          console.error("Error saving friend image:", err);
        }
      }

      io.to(roomId).emit("receive_image", {
        from: socket.id,
        fromUserId: u.id,
        roomId: roomId,
        dataUrl,
        timestamp: new Date().toISOString(),
        replyTo: replyTo || null,
        messageId: msgId,
      });
    });

    // ── GIF ──
    socket.on("send_gif", async ({ gifUrl, roomId, replyTo, messageId }) => {
      if (u.guest) {
        socket.emit("media_error", { msg: "Sign in to send GIFs" });
        return;
      }
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      if (roomId && !roomId.startsWith("f_")) {
        tryClaim(roomId);
        const c = chats.get(socket.id);
        if (c && c.partnerId) {
          io.to(c.partnerId).emit("opener_used");
          socket.emit("opener_used");
        }
      }

      if (!gifUrl || typeof gifUrl !== 'string') return;
      const msgId = messageId || ("msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9));

      if (roomId && roomId.startsWith("f_")) {
        const friendshipId = roomId.substring(2);
        try {
          await supabase.from("friend_messages").insert({
            friendship_id: friendshipId,
            sender_id: u.id,
            content: gifUrl,
            type: "gif",
            reply_to: replyTo || null,
            message_id: msgId,
            seen: false
          });
        } catch (err) {
          console.error("Error saving friend gif:", err);
        }
      }

      io.to(roomId).emit("receive_gif", {
        from: socket.id,
        fromUserId: u.id,
        roomId: roomId,
        gifUrl,
        timestamp: new Date().toISOString(),
        replyTo: replyTo || null,
        messageId: msgId,
      });
    });

    // ── Voice — send as proper audio blob ──
    socket.on("send_voice", async ({ dataUrl, roomId, mimeType, duration, replyTo, messageId }) => {
      if (u.guest) {
        socket.emit("media_error", { msg: "Sign in to send voice" });
        return;
      }
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      if (roomId && !roomId.startsWith("f_")) {
        tryClaim(roomId);
        const c = chats.get(socket.id);
        if (c && c.partnerId) {
          io.to(c.partnerId).emit("opener_used");
          socket.emit("opener_used");
        }
      }

      if (!dataUrl?.startsWith("data:audio/")) return;
      if (dataUrl.length > 4 * 1024 * 1024) {
        socket.emit("media_error", { msg: "Voice too large (max 4MB)" });
        return;
      }
      const msgId = messageId || ("msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9));

      if (roomId && roomId.startsWith("f_")) {
        const friendshipId = roomId.substring(2);
        try {
          await supabase.from("friend_messages").insert({
            friendship_id: friendshipId,
            sender_id: u.id,
            content: dataUrl,
            type: "voice",
            mime_type: mimeType || "audio/webm",
            duration: duration || null,
            reply_to: replyTo || null,
            message_id: msgId,
            seen: false
          });
        } catch (err) {
          console.error("Error saving friend voice:", err);
        }
      }

      io.to(roomId).emit("receive_voice", {
        from: socket.id,
        fromUserId: u.id,
        roomId: roomId,
        dataUrl,
        mimeType: mimeType || "audio/webm",
        duration: duration || null,
        timestamp: new Date().toISOString(),
        replyTo: replyTo || null,
        messageId: msgId,
      });
    });

    // ── Edit Message ──
    socket.on("edit_message", async ({ messageId, roomId, newMessage }) => {
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      let msg = newMessage?.trim();
      if (!msg || msg.length > 500) return;
      try {
        msg = filter.clean(msg);
      } catch { }

      if (roomId && roomId.startsWith("f_")) {
        try {
          await supabase.from("friend_messages")
            .update({ content: msg, edited: true })
            .eq("message_id", messageId);
        } catch (err) {
          console.error("Error updating friend message:", err);
        }
      }

      io.to(roomId).emit("message_edited", {
        messageId,
        roomId,
        newMessage: msg,
      });
    });

    // ── Delete Message (Unsend) ──
    socket.on("delete_message", async ({ messageId, roomId }) => {
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      if (roomId && roomId.startsWith("f_")) {
        try {
          await supabase.from("friend_messages")
            .delete()
            .eq("message_id", messageId);
        } catch (err) {
          console.error("Error deleting friend message:", err);
        }
      }

      io.to(roomId).emit("message_deleted", {
        messageId,
        roomId,
      });
    });

    // ── Message Reaction ──
    socket.on("message_reaction", async ({ messageId, roomId, emoji }) => {
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      io.to(roomId).emit("message_reaction_received", {
        messageId,
        roomId,
        emoji,
        senderId: socket.u?.id || null
      });
    });

    // ── Message Seen Receipts (Delete on Seen) ──
    socket.on("message_seen", async ({ messageId, roomId }) => {
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      if (roomId && roomId.startsWith("f_")) {
        try {
          await supabase.from("friend_messages")
            .delete()
            .eq("message_id", messageId);
        } catch (err) {
          console.error("Error deleting seen message:", err);
        }
      }

      socket.to(roomId).emit("message_seen", { messageId, roomId });
    });

    socket.on("chat_seen", async ({ roomId }) => {
      let isAllowed = false;
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (c && c.roomId === roomId) isAllowed = true;
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) isAllowed = true;
      }
      if (!isAllowed) return;

      if (roomId && roomId.startsWith("f_")) {
        const friendshipId = roomId.substring(2);
        try {
          await supabase.from("friend_messages")
            .delete()
            .eq("friendship_id", friendshipId)
            .neq("sender_id", u.id);
        } catch (err) {
          console.error("Error deleting seen chat messages:", err);
        }
      }

      socket.to(roomId).emit("chat_seen", { roomId });
    });

    socket.on("typing", ({ roomId, isTyping }) => {
      if (chats.has(socket.id)) {
        const c = chats.get(socket.id);
        if (!c || c.roomId !== roomId || !c.partnerId) return;
        io.to(c.partnerId).emit("partner_typing", { isTyping: !!isTyping });
      } else if (roomId && roomId.startsWith("f_")) {
        if (socket.rooms.has(roomId)) {
          socket.to(roomId).emit("partner_typing", { isTyping: !!isTyping });
        }
      }
    });

    socket.on("skip", async () => {
      endChat(socket);
      // After ending chat, check if someone is waiting to reconnect with this user
      const reconnected = await matchWithPendingUndo(socket);
      if (!reconnected) {
        socket.emit("skipped");
      }
    });

    socket.on("undo_skip", async ({ targetUserId }) => {
      if (!targetUserId) return;
      const partnerSocket = [...io.sockets.sockets.values()].find(
        (s) => s.u?.id === targetUserId,
      );

      if (!partnerSocket) {
        socket.emit("media_error", { msg: "Stranger is no longer online." });
        return;
      }

      const inChat = chats.has(partnerSocket.id);

      if (!inChat) {
        // ── Target is free — connect immediately ──
        queue.delete(socket.id);
        queue.delete(partnerSocket.id);

        const room =
          "r_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
        socket.join(room);
        partnerSocket.join(room);

        chats.set(socket.id, {
          partnerId: partnerSocket.id,
          roomId: room,
          partnerUserId: targetUserId,
        });
        chats.set(partnerSocket.id, {
          partnerId: socket.id,
          roomId: room,
          partnerUserId: u.id || null,
        });

        const ci = common(u.int, partnerSocket.u?.int);

        let meStatus = "none",
          partnerStatus = "none";
        if (u.id && targetUserId) {
          const { data: fs } = await supabase
            .from("friendships")
            .select("user_id,friend_id,status")
            .or(
              `and(user_id.eq.${u.id},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${u.id})`,
            );
          if (fs && fs.length > 0) {
            const row = fs[0];
            const accepted = row.status === "accepted";
            meStatus = accepted
              ? "friends"
              : row.user_id === u.id
                ? "pending"
                : "incoming";
            partnerStatus = accepted
              ? "friends"
              : row.user_id === targetUserId
                ? "pending"
                : "incoming";
          }
        }

        const mkPayload = (
          name,
          gender,
          id,
          verified,
          premium,
          premiumAnnual,
          dev,
          admin,
          adminTitle,
          myStatus,
          locked,
          theme,
          country,
          state,
          city,
        ) => ({
          partnerUsername: name,
          partnerGender: gender,
          partnerVerified: verified,
          partnerVip: premium,
          partnerVipAnnual: premiumAnnual,
          partnerDev: dev,
          partnerAdmin: admin,
          partnerAdminTitle: adminTitle,
          partnerUserId: id || null,
          commonInterests: ci,
          roomId: room,
          friendshipStatus: myStatus,
          profileLocked: locked,
          chatTheme: theme,
          country,
          state,
          city,
        });

        const pu = partnerSocket.u || {};
        io.to(socket.id).emit(
          "matched",
          mkPayload(
            pu.name,
            pu.gender,
            pu.id || targetUserId,
            pu.verified,
            pu.premium,
            pu.premiumAnnual,
            pu.dev,
            pu.admin,
            pu.adminTitle,
            meStatus,
            pu.locked,
            pu.theme || "default",
            pu.country,
            pu.state,
            pu.city,
          ),
        );
        io.to(partnerSocket.id).emit(
          "matched",
          mkPayload(
            u.name,
            u.gender,
            u.id,
            u.verified,
            u.premium,
            u.premiumAnnual,
            u.dev,
            u.admin,
            u.adminTitle,
            partnerStatus,
            u.locked,
            u.theme,
            u.country,
            u.state,
            u.city,
          ),
        );
        io.to(room).emit("receive_message", {
          from: "system",
          message: "✨ Match restored via Undo Skip!",
          timestamp: new Date().toISOString(),
        });
        console.log(`↩️ Undo skip immediate: ${u.name} <-> ${pu.name}`);
      } else {
        // ── Target is currently in another chat — enter 30-min wait queue ──
        // Cancel any previous pending undo from this requester for the same target
        const existingEntry = pendingUndoQueue.get(targetUserId);
        if (existingEntry) {
          clearTimeout(existingEntry.timer);
        }

        const WAIT_MS = 30 * 60 * 1000; // 30 minutes

        const timer = setTimeout(() => {
          // Time expired — remove from waiting queue and send to normal search
          const entry = pendingUndoQueue.get(targetUserId);
          if (entry && entry.requesterSid === socket.id) {
            pendingUndoQueue.delete(targetUserId);
            socket.emit("undo_skip_expired");
            console.log(
              `⏰ Undo skip expired for ${u.name} waiting for userId=${targetUserId}`,
            );
          }
        }, WAIT_MS);

        pendingUndoQueue.set(targetUserId, {
          requesterSid: socket.id,
          requesterUserId: u.id || null,
          timer,
        });

        // Put requester in a special waiting state (not in normal queue)
        queue.delete(socket.id);

        // Notify requester they are now waiting
        socket.emit("undo_skip_waiting", { waitMinutes: 30 });

        // Notify the target (partner) that someone wants to reconnect
        partnerSocket.emit("undo_skip_incoming", { fromUsername: u.name });

        console.log(
          `⏳ Undo skip WAIT: ${u.name} waiting for userId=${targetUserId} (30 min)`,
        );
      }
    });

    // ── Friend request ──
    socket.on("send_friend_request", async ({ targetUserId }) => {
      if (u.guest || !targetUserId || !u.id) return;
      try {
        const { data: ex } = await supabase
          .from("friendships")
          .select("id")
          .or(
            `and(user_id.eq.${u.id},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${u.id})`,
          )
          .maybeSingle();
        if (ex) {
          socket.emit("friend_request_result", {
            success: false,
            message: "Already sent or friends",
          });
          return;
        }
        const { data: newFr } = await supabase
          .from("friendships")
          .insert({
            user_id: u.id,
            friend_id: targetUserId,
            status: "pending",
          })
          .select("id")
          .maybeSingle();

        const requestId = newFr?.id;

        socket.emit("friend_request_result", {
          success: true,
          message: "Friend request sent!",
          requestId,
        });
        // notify partner if online
        const partnerSocket = [...io.sockets.sockets.values()].find(
          (s) => s.u?.id === targetUserId,
        );
        if (partnerSocket) {
          partnerSocket.emit("incoming_friend_request", {
            fromUsername: u.name,
            fromUserId: u.id,
            requestId,
          });
        }
      } catch {
        socket.emit("friend_request_result", {
          success: false,
          message: "Error sending request",
        });
      }
    });

    // ── Respond to Friend request ──
    socket.on("respond_friend_request", async ({ requestId, action }) => {
      if (u.guest || !requestId || !u.id) return;
      try {
        const { data: fr } = await supabase
          .from("friendships")
          .select("*")
          .eq("id", requestId)
          .eq("friend_id", u.id)
          .maybeSingle();
        if (!fr) {
          socket.emit("respond_friend_result", {
            success: false,
            message: "Friend request not found",
          });
          return;
        }

        if (action === "accept") {
          await supabase
            .from("friendships")
            .update({ status: "accepted" })
            .eq("id", requestId);

          socket.emit("respond_friend_result", {
            success: true,
            requestId,
            action: "accept",
            message: "Friend added!",
          });

          // notify sender if online
          const partnerSocket = [...io.sockets.sockets.values()].find(
            (s) => s.u?.id === fr.user_id,
          );
          if (partnerSocket) {
            partnerSocket.emit("friend_request_accepted", {
              friendId: u.id,
              friendUsername: u.name,
              requestId,
            });
          }
        } else {
          await supabase
            .from("friendships")
            .delete()
            .eq("id", requestId);

          socket.emit("respond_friend_result", {
            success: true,
            requestId,
            action: "reject",
            message: "Request rejected.",
          });
        }
      } catch (err) {
        console.error("respond_friend_request error:", err);
        socket.emit("respond_friend_result", {
          success: false,
          message: "Error responding to request",
        });
      }
    });

    // ── Report ──
    socket.on("report_partner", async ({ reason }) => {
      const c = chats.get(socket.id);
      if (!c) return;
      const ps = io.sockets.sockets.get(c.partnerId);
      if (!ps || ps.u?.guest) return;
      const cnt = (reports.get(c.partnerId) || 0) + 1;
      reports.set(c.partnerId, cnt);
      if (cnt >= 3 && ps.u?.id) {
        const { data: row } = await supabase
          .from("users")
          .select("trust_score,report_count")
          .eq("id", ps.u.id)
          .maybeSingle();
        if (row)
          await supabase
            .from("users")
            .update({
              trust_score: Math.max(0, (row.trust_score || 100) - 10),
              report_count: (row.report_count || 0) + 1,
            })
            .eq("id", ps.u.id);
      }
      if (cnt >= 5 && ps.u?.id) {
        await supabase
          .from("users")
          .update({
            is_banned: true,
            ban_expiry: new Date(Date.now() + 86400000).toISOString(),
          })
          .eq("id", ps.u.id);
        io.to(c.partnerId).emit("banned", { message: "Suspended 24h." });
      }
      socket.emit("report_sent");
    });

    // ── Premium Actions ──
    socket.on("send_superlike", ({ targetUserId, roomId }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      io.to(c.partnerId).emit("receive_superlike");
    });

    socket.on("send_compliment", ({ targetUserId, roomId }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      io.to(c.partnerId).emit("receive_compliment");
    });

    socket.on("send_rose", ({ targetUserId, roomId }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      io.to(c.partnerId).emit("receive_rose");
    });

    socket.on("send_tip", ({ targetUserId, roomId, amount }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      io.to(c.partnerId).emit("receive_tip", { amount });
    });

    socket.on("update_theme", ({ themeColor }) => {
      socket.u.theme = themeColor;
      const c = chats.get(socket.id);
      if (c && c.partnerId) {
        io.to(c.partnerId).emit("partner_theme_updated", { themeColor });
      }
    });

    // ── AI Opener (one-per-room) ──
    // First user to use it owns the opener; partner's button is hidden
    socket.on("opener_used", ({ roomId }) => {
      const c = chats.get(socket.id);
      if (!c || c.roomId !== roomId) return;
      tryClaim(roomId);
      io.to(c.partnerId).emit("opener_used");
      socket.emit("opener_used");
      console.log(`💬 AI opener used by ${u.name} in room=${roomId}`);
    });

    // ── Rematch Actions ──
    socket.on("send_rematch", ({ targetUserId, roomId }) => {
      if (u.guest || !targetUserId) return;
      const partnerSocket = [...io.sockets.sockets.values()].find(
        (s) => s.u?.id === targetUserId,
      );
      if (partnerSocket) {
        partnerSocket.emit("receive_rematch", {
          fromUsername: u.name,
          fromUserId: u.id,
          roomId: roomId,
        });
      }
    });

    socket.on("decline_rematch", async ({ targetUserId }) => {
      if (!targetUserId) return;
      const senderSocket = [...io.sockets.sockets.values()].find(
        (s) => s.u?.id === targetUserId,
      );
      if (senderSocket) {
        senderSocket.emit("rematch_declined", {
          message: `${u.name} declined the re-match.`,
        });
      }
      await supabase
        .from("rematch_requests")
        .update({ status: "rejected" })
        .eq("sender_id", targetUserId)
        .eq("receiver_id", u.id);
    });

    socket.on("accept_rematch", async ({ targetUserId }) => {
      if (u.guest || !targetUserId || !u.id) return;
      const senderSocket = [...io.sockets.sockets.values()].find(
        (s) => s.u?.id === targetUserId,
      );
      if (senderSocket) {
        const newRoom =
          "r_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
        socket.join(newRoom);
        senderSocket.join(newRoom);

        chats.set(socket.id, {
          partnerId: senderSocket.id,
          roomId: newRoom,
          partnerUserId: senderSocket.u.id,
        });
        chats.set(senderSocket.id, {
          partnerId: socket.id,
          roomId: newRoom,
          partnerUserId: u.id,
        });

        await supabase
          .from("rematch_requests")
          .update({ status: "accepted" })
          .eq("sender_id", targetUserId)
          .eq("receiver_id", u.id);

        const ci = common(u.int, senderSocket.u.int);

        let meStatus = "none",
          partnerStatus = "none";
        const { data: fs } = await supabase
          .from("friendships")
          .select("user_id,friend_id,status")
          .or(
            `and(user_id.eq.${u.id},friend_id.eq.${senderSocket.u.id}),and(user_id.eq.${senderSocket.u.id},friend_id.eq.${u.id})`,
          );
        if (fs && fs.length > 0) {
          const row = fs[0];
          const accepted = row.status === "accepted";
          meStatus = accepted
            ? "friends"
            : row.user_id === u.id
              ? "pending"
              : "incoming";
          partnerStatus = accepted
            ? "friends"
            : row.user_id === senderSocket.u.id
              ? "pending"
              : "incoming";
        }

        const mkPayload = (
          name,
          gender,
          id,
          verified,
          premium,
          premiumAnnual,
          dev,
          admin,
          adminTitle,
          myStatus,
          locked,
          theme,
          country,
          state,
          city,
          interests,
        ) => ({
          partnerUsername: name,
          partnerGender: gender,
          partnerVerified: verified,
          partnerVip: premium,
          partnerVipAnnual: premiumAnnual,
          partnerDev: dev,
          partnerAdmin: admin,
          partnerAdminTitle: adminTitle,
          partnerUserId: id || null,
          commonInterests: ci,
          roomId: newRoom,
          friendshipStatus: myStatus,
          profileLocked: locked,
          chatTheme: theme,
          country: country,
          state: state,
          city: city,
          partnerInterests: interests || [],
        });

        socket.emit(
          "matched",
          mkPayload(
            senderSocket.u.name,
            senderSocket.u.gender,
            senderSocket.u.id,
            senderSocket.u.verified,
            senderSocket.u.premium,
            senderSocket.u.premiumAnnual,
            senderSocket.u.dev,
            senderSocket.u.admin,
            senderSocket.u.adminTitle,
            meStatus,
            senderSocket.u.locked,
            senderSocket.u.theme || "default",
            senderSocket.u.country,
            senderSocket.u.state,
            senderSocket.u.city,
            senderSocket.u.int || [],
          ),
        );

        senderSocket.emit(
          "matched",
          mkPayload(
            u.name,
            u.gender,
            u.id,
            u.verified,
            u.premium,
            u.premiumAnnual,
            u.dev,
            u.admin,
            u.adminTitle,
            partnerStatus,
            u.locked,
            u.theme || "default",
            u.country,
            u.state,
            u.city,
            u.int || [],
          ),
        );

        socket.emit("rematch_success");
        senderSocket.emit("rematch_success");
      } else {
        socket.emit("media_error", {
          msg: "Partner is offline or unavailable.",
        });
      }
    });

    socket.on("disconnecting", () => {
      for (const roomName of socket.rooms) {
        if (roomName.startsWith("f_")) {
          socket.to(roomName).emit("partner_status", { online: false });
        }
      }
    });

    socket.on("disconnect", () => {
      queue.delete(socket.id);
      // Clean up pending undo entries where this user was the REQUESTER (they left while waiting)
      for (const [tuid, entry] of pendingUndoQueue.entries()) {
        if (entry.requesterSid === socket.id) {
          clearTimeout(entry.timer);
          pendingUndoQueue.delete(tuid);
        }
      }
      // If this user was the TARGET someone was waiting for, notify the requester they're gone
      if (u.id && pendingUndoQueue.has(u.id)) {
        const entry = pendingUndoQueue.get(u.id);
        clearTimeout(entry.timer);
        pendingUndoQueue.delete(u.id);
        const requesterSocket = io.sockets.sockets.get(entry.requesterSid);
        if (requesterSocket) {
          requesterSocket.emit("media_error", {
            msg: "Stranger went offline while you were waiting.",
          });
          requesterSocket.emit("undo_skip_expired"); // reset to idle
        }
      }
      endChat(socket);
      console.log(`🔌 Left: ${u.name} queue=${queue.size}`);
    });

    async function matchWithPendingUndo(s) {
      // Check if someone is waiting in the undo-skip queue for this user
      if (!s.u?.id) return false;
      const entry = pendingUndoQueue.get(s.u.id);
      if (!entry) return false;

      const requesterSocket = io.sockets.sockets.get(entry.requesterSid);
      if (!requesterSocket || !requesterSocket.connected) {
        // Requester has gone offline — clean up
        clearTimeout(entry.timer);
        pendingUndoQueue.delete(s.u.id);
        return false;
      }

      // Clear the waiting timer
      clearTimeout(entry.timer);
      pendingUndoQueue.delete(s.u.id);

      // Remove both from normal queue (safety)
      queue.delete(s.id);
      queue.delete(requesterSocket.id);

      const room =
        "r_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
      s.join(room);
      requesterSocket.join(room);

      chats.set(s.id, {
        partnerId: requesterSocket.id,
        roomId: room,
        partnerUserId: entry.requesterUserId,
      });
      chats.set(requesterSocket.id, {
        partnerId: s.id,
        roomId: room,
        partnerUserId: s.u.id,
      });

      const ci = common(s.u.int, requesterSocket.u?.int);
      const ru = requesterSocket.u || {};

      let meStatus = "none",
        partnerStatus = "none";
      if (s.u.id && ru.id) {
        const { data: fs } = await supabase
          .from("friendships")
          .select("user_id,friend_id,status")
          .or(
            `and(user_id.eq.${s.u.id},friend_id.eq.${ru.id}),and(user_id.eq.${ru.id},friend_id.eq.${s.u.id})`,
          );
        if (fs && fs.length > 0) {
          const row = fs[0];
          const accepted = row.status === "accepted";
          meStatus = accepted
            ? "friends"
            : row.user_id === s.u.id
              ? "pending"
              : "incoming";
          partnerStatus = accepted
            ? "friends"
            : row.user_id === ru.id
              ? "pending"
              : "incoming";
        }
      }

      const mkPayload = (
        name,
        gender,
        id,
        verified,
        premium,
        premiumAnnual,
        dev,
        admin,
        adminTitle,
        myStatus,
        locked,
        theme,
        country,
        state,
        city,
      ) => ({
        partnerUsername: name,
        partnerGender: gender,
        partnerVerified: verified,
        partnerVip: premium,
        partnerVipAnnual: premiumAnnual,
        partnerDev: dev,
        partnerAdmin: admin,
        partnerAdminTitle: adminTitle,
        partnerUserId: id || null,
        commonInterests: ci,
        roomId: room,
        friendshipStatus: myStatus,
        profileLocked: locked,
        chatTheme: theme,
        country,
        state,
        city,
      });

      // Target (s) receives requester's info
      io.to(s.id).emit(
        "matched",
        mkPayload(
          ru.name,
          ru.gender,
          ru.id,
          ru.verified,
          ru.premium,
          ru.premiumAnnual,
          ru.dev,
          ru.admin,
          ru.adminTitle,
          meStatus,
          ru.locked,
          ru.theme || "default",
          ru.country,
          ru.state,
          ru.city,
        ),
      );
      // Requester receives target's info
      io.to(requesterSocket.id).emit(
        "matched",
        mkPayload(
          s.u.name,
          s.u.gender,
          s.u.id,
          s.u.verified,
          s.u.premium,
          s.u.premiumAnnual,
          s.u.dev,
          s.u.admin,
          s.u.adminTitle,
          partnerStatus,
          s.u.locked,
          s.u.theme || "default",
          s.u.country,
          s.u.state,
          s.u.city,
        ),
      );
      io.to(room).emit("receive_message", {
        from: "system",
        message: "✨ Reconnected via Undo Skip!",
        timestamp: new Date().toISOString(),
      });

      console.log(
        `↩️ Undo skip MATCH: ${ru.name} <-> ${s.u.name} (waited in queue)`,
      );
      return true;
    }

    function endChat(s) {
      const c = chats.get(s.id);
      if (!c) return;
      io.to(c.partnerId).emit("partner_disconnected");
      s.leave(c.roomId);
      io.sockets.sockets.get(c.partnerId)?.leave(c.roomId);
      chats.delete(s.id);
      chats.delete(c.partnerId);
    }
  });
};
