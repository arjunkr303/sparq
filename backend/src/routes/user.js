const express = require("express");
const supabase = require("../supabase");
const { tryClaim } = require("../openerRooms");
const authMw = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const router = express.Router();

const DEV_EMAILS = ["arjunsreechakram@gmail.com", "jithubaiju124@gmail.com"];

const clean = (u) => {
  const isDevEmail = u.email && DEV_EMAILS.includes(u.email.toLowerCase());
  const now = new Date();
  
  // Force premium / VIP for everyone
  u.is_premium = true;
  u.premium_expiry = "2099-12-31T23:59:59.000Z";
  u.is_verified = true;

  const isPremium = true;
  const isPremiumAnnual = true;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    gender: u.gender,
    age: u.age,
    country: u.country || "",
    state: u.state || "",
    city: u.city || "",
    interests: u.interests || [],
    isVerified: isDevEmail || u.is_verified || false,
    isPremium: !!isPremium,
    isPremiumAnnual: !!isPremiumAnnual,
    isAdmin: isDevEmail || u.is_admin || false,
    adminTitle: isDevEmail ? "Developer" : (u.admin_title || null),
    coins: isDevEmail ? 999999 : (u.coins || 0),
    twoFAEnabled: u.two_fa_enabled || false,
    memberSince: u.created_at || null,
    profilePhoto: u.profile_photo || null,
    trustScore: isDevEmail ? 100 : (u.trust_score || 100),
    reportCount: isDevEmail ? 0 : (u.report_count || 0),
    premiumExpiry: isDevEmail ? "2099-12-31T23:59:59.000Z" : (u.premium_expiry || null),
    auraExpiry: isDevEmail ? "2099-12-31T23:59:59.000Z" : (u.aura_expiry || null),
    chatTheme: isDevEmail ? (u.chat_theme || "premium") : (u.chat_theme || 'default'),
    themeExpiry: isDevEmail ? "2099-12-31T23:59:59.000Z" : (u.theme_expiry || null),
    dev: isDevEmail,
  };
};

// ── get me ──
router.get("/me", authMw, async (req, res) => {
  res.json({ user: clean(req.user) });
});

// ── update profile ──
router.put("/update", authMw, async (req, res) => {
  try {
    const { username, country, state, city, interests } = req.body;
    const upd = {};
    if (country !== undefined) upd.country = country;
    if (state !== undefined) upd.state = state;
    if (city !== undefined) upd.city = city;
    if (interests !== undefined) upd.interests = interests;
    if (username) {
      const { data: ex } = await supabase
        .from("users")
        .select("id")
        .eq("username", username)
        .neq("id", req.user.id)
        .maybeSingle();
      if (ex) return res.status(400).json({ message: "Username taken" });
      upd.username = username;
    }
    const { data: u, error } = await supabase
      .from("users")
      .update(upd)
      .eq("id", req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ message: "Update failed" });
    res.json({ user: clean(u) });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ── upload profile photo (base64) ──
router.post("/photo", authMw, async (req, res) => {
  try {
    const { photoBase64 } = req.body;
    if (!photoBase64)
      return res.status(400).json({ message: "No photo provided" });
    // Limit size to ~800KB base64
    if (photoBase64.length > 1100000)
      return res.status(400).json({ message: "Photo too large. Max 800KB." });
    if (!photoBase64.startsWith("data:image/"))
      return res.status(400).json({ message: "Invalid image format" });

    const { data: u, error } = await supabase
      .from("users")
      .update({ profile_photo: photoBase64 })
      .eq("id", req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ message: "Photo upload failed" });
    res.json({ user: clean(u), message: "Photo updated!" });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ── verify face ──
router.post("/verify", authMw, async (req, res) => {
  try {
    const { data: u } = await supabase
      .from("users")
      .update({ is_verified: true })
      .eq("id", req.user.id)
      .select()
      .single();
    res.json({ user: clean(u), message: "Verified!" });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ── update gender ──
router.put("/update-gender", authMw, async (req, res) => {
  try {
    const { gender } = req.body;
    if (!["male", "female", "other"].includes(gender))
      return res.status(400).json({ message: "Invalid gender value" });

    const { data: u, error } = await supabase
      .from("users")
      .update({ gender })
      .eq("id", req.user.id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: "Update failed" });
    res.json({ user: clean(u), message: "Gender updated!" });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});


// ── spend coins ──
router.post("/spend-coins", authMw, async (req, res) => {
  try {
    const { amount, itemId, extra } = req.body;
    if (!amount || amount < 1 || !itemId)
      return res.status(400).json({ message: "Invalid request" });
    if ((req.user.coins || 0) < amount)
      return res.status(400).json({ message: "Not enough coins" });

    if (
      ["superlike", "compliment", "rematch", "rose"].includes(itemId) &&
      !extra?.targetUserId
    ) {
      return res
        .status(400)
        .json({ message: `Target user is required for ${itemId}` });
    }

    if (itemId === "opener") {
      if (!extra?.roomId) {
        return res
          .status(400)
          .json({ message: "Active chat room is required for opener" });
      }
      if (!tryClaim(extra.roomId)) {
        return res
          .status(409)
          .json({ message: "AI opener already used in this chat" });
      }
    }

    const upd = { coins: req.user.coins - amount };
    const now = new Date();

    let reward = null;
    if (itemId === "luckydraw") {
      const rand = Math.random();
      if (rand < 0.35) {
        reward = { type: "coins", amount: 5, label: "Win 5 Coins back! 🪙" };
        upd.coins += 5;
      } else if (rand < 0.65) {
        reward = { type: "nothing", amount: 0, label: "Better luck next time! 😢" };
      } else if (rand < 0.80) {
        reward = { type: "coins", amount: 15, label: "Win 15 Coins! 🪙" };
        upd.coins += 15;
      } else if (rand < 0.90) {
        reward = { type: "coins", amount: 25, label: "Win 25 Coins! 🪙" };
        upd.coins += 25;
      } else if (rand < 0.95) {
        const themes = ["rose", "passion", "sunset", "serenade", "premium", "purple"];
        const chosenTheme = themes[Math.floor(Math.random() * themes.length)];
        reward = { type: "theme", amount: 7, label: `Win 7 Days of ${chosenTheme.toUpperCase()} Chat Theme! 🎭`, value: chosenTheme };
        upd.chat_theme = chosenTheme;
        upd.theme_expiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (rand < 0.99) {
        reward = { type: "vip", amount: 7, label: "Win 7 Days of VIP Status! 👑" };
        upd.is_premium = true;
        upd.premium_expiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      } else {
        reward = { type: "coins", amount: 100, label: "💥 JACKPOT! Win 100 Coins! 🪙" };
        upd.coins += 100;
      }
    }

    if (itemId === "boost") {
      upd.queue_boost_expiry = new Date(
        now.getTime() + 60 * 60 * 1000,
      ).toISOString();
    } else if (itemId === "theme") {
      upd.chat_theme = extra?.themeColor || "premium";
      upd.theme_expiry = new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
    } else if (itemId === "lock") {
      upd.profile_lock_expiry = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
    } else if (itemId === "likes") {
      upd.reveal_likes_expiry = new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
    } else if (itemId === "aura") {
      upd.aura_expiry = new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(); // 1 week
    }

    const { data: u } = await supabase
      .from("users")
      .update(upd)
      .eq("id", req.user.id)
      .select()
      .single();

    // Log interactions for superlike, compliment, or rematch if target is provided
    if (
      ["superlike", "compliment", "rematch", "rose"].includes(itemId) &&
      extra?.targetUserId
    ) {
      if (itemId === "rematch") {
        await supabase.from("rematch_requests").insert({
          sender_id: req.user.id,
          receiver_id: extra.targetUserId,
        });
      } else {
        await supabase.from("user_interactions").insert({
          sender_id: req.user.id,
          receiver_id: extra.targetUserId,
          interaction_type: itemId,
          is_anonymous: itemId === "compliment",
        });
      }
    }

    // Include the new fields in the clean object if needed, or just return the standard clean(u)
    const cleaned = clean(u);
    cleaned.queueBoostExpiry = u.queue_boost_expiry;
    cleaned.themeExpiry = u.theme_expiry;
    cleaned.chatTheme = u.chat_theme;
    cleaned.profileLockExpiry = u.profile_lock_expiry;
    cleaned.revealLikesExpiry = u.reveal_likes_expiry;
    cleaned.auraExpiry = u.aura_expiry;

    res.json({ user: cleaned, reward });
  } catch (err) {
    console.error("Spend coins error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── friends: send request ──
router.post("/friends/request", authMw, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId || targetUserId === req.user.id)
      return res.status(400).json({ message: "Invalid target" });

    const { data: ex } = await supabase
      .from("friendships")
      .select("id")
      .or(
        `and(user_id.eq.${req.user.id},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${req.user.id})`,
      )
      .maybeSingle();
    if (ex)
      return res
        .status(400)
        .json({ message: "Already sent or already friends" });

    await supabase.from("friendships").insert({
      user_id: req.user.id,
      friend_id: targetUserId,
      status: "pending",
    });
    res.json({ message: "Friend request sent!" });
  } catch (err) {
    console.error("Friend request error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── friends: respond ──
router.post("/friends/respond", authMw, async (req, res) => {
  try {
    const { requestId, action } = req.body;
    const { data: fr } = await supabase
      .from("friendships")
      .select("*")
      .eq("id", requestId)
      .eq("friend_id", req.user.id)
      .maybeSingle();
    if (!fr) return res.status(404).json({ message: "Request not found" });

    if (action === "accept") {
      await supabase
        .from("friendships")
        .update({ status: "accepted" })
        .eq("id", requestId);
      res.json({ message: "Friend added!" });
    } else {
      await supabase.from("friendships").delete().eq("id", requestId);
      res.json({ message: "Request rejected." });
    }
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ── friends: list ──
router.get("/friends", authMw, async (req, res) => {
  try {
    const { data: rows } = await supabase
      .from("friendships")
      .select(
        "id, status, user_id, friend_id, sender:users!friendships_user_id_fkey(id,username,is_verified,is_premium,profile_photo), receiver:users!friendships_friend_id_fkey(id,username,is_verified,is_premium,profile_photo)",
      )
      .or(`user_id.eq.${req.user.id},friend_id.eq.${req.user.id}`);

    // Fetch unread messages count for each friendship where recipient is the current user
    const { data: unreads } = await supabase
      .from("friend_messages")
      .select("friendship_id")
      .neq("sender_id", req.user.id)
      .eq("seen", false);

    const unreadMap = {};
    if (unreads) {
      unreads.forEach(u => {
        unreadMap[u.friendship_id] = (unreadMap[u.friendship_id] || 0) + 1;
      });
    }

    const friendsWithUnread = (rows || []).map(f => ({
      ...f,
      unreadCount: unreadMap[f.id] || 0
    }));

    res.json({ friends: friendsWithUnread });
  } catch (err) {
    console.error("Friends list error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── friends: get messages ──
router.get("/friends/messages", authMw, async (req, res) => {
  try {
    const { friendshipId } = req.query;
    if (!friendshipId)
      return res.status(400).json({ message: "Friendship ID is required" });

    // Verify friendship exists and includes the current user
    const { data: fr } = await supabase
      .from("friendships")
      .select("id, user_id, friend_id")
      .eq("id", friendshipId)
      .maybeSingle();

    if (!fr)
      return res.status(404).json({ message: "Friendship not found" });

    if (fr.user_id !== req.user.id && fr.friend_id !== req.user.id)
      return res.status(403).json({ message: "Unauthorized" });

    // Fetch messages
    const { data: msgs, error } = await supabase
      .from("friend_messages")
      .select("*")
      .eq("friendship_id", friendshipId)
      .order("created_at", { ascending: true });

    if (error)
      return res.status(500).json({ message: "Failed to fetch messages" });

    res.json({ messages: msgs || [] });
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── admin: give badge ──
router.post("/admin/badge", authMw, async (req, res) => {
  try {
    if (!req.user.is_admin)
      return res.status(403).json({ message: "Not authorized" });
    const { targetUsername, badge } = req.body;
    const { data: target } = await supabase
      .from("users")
      .select("id")
      .eq("username", targetUsername)
      .maybeSingle();
    if (!target) return res.status(404).json({ message: "User not found" });
    const upd = {};
    if (badge === "admin") upd.is_admin = true;
    if (badge === "verified") upd.is_verified = true;
    if (badge === "premium") upd.is_premium = true;
    if (badge === "remove_admin") upd.is_admin = false;
    await supabase.from("users").update(upd).eq("id", target.id);
    res.json({ message: `Done` });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ── interactions: get admirers ──
router.get("/interactions", authMw, async (req, res) => {
  try {
    const { data: rows } = await supabase
      .from("user_interactions")
      .select(
        "id, interaction_type, is_anonymous, created_at, sender:users!user_interactions_sender_id_fkey(username, gender)",
      )
      .eq("receiver_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    const now = new Date();
    const canSee =
      req.user.reveal_likes_expiry &&
      new Date(req.user.reveal_likes_expiry) > now;

    const admirers = (rows || []).map((r) => {
      let name = r.sender?.username || "Unknown";
      if (r.is_anonymous || !canSee) {
        name = "Someone (" + (r.sender?.gender || "unknown") + ")";
      }
      return {
        id: r.id,
        type: r.interaction_type,
        senderName: name,
        date: r.created_at,
        isRevealed: canSee && !r.is_anonymous,
      };
    });

    res.json({ admirers, canSee });
  } catch (err) {
    console.error("Interactions error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
