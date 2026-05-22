const express = require("express");
const supabase = require("../supabase");
const authMw = require("../middleware/auth");
const router = express.Router();

const clean = (u) => {
  const now = new Date();
  const isPremiumAnnual =
    u.is_premium &&
    u.premium_expiry &&
    new Date(u.premium_expiry) - now > 35 * 24 * 60 * 60 * 1000;
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
    isVerified: u.is_verified || false,
    isPremium: !!(
      u.is_premium &&
      u.premium_expiry &&
      new Date(u.premium_expiry) > now
    ),
    isPremiumAnnual: !!isPremiumAnnual,
    isAdmin: u.is_admin || false,
    adminTitle: u.admin_title || null,
    coins: u.coins || 0,
    twoFAEnabled: u.two_fa_enabled || false,
    memberSince: u.created_at || null,
    profilePhoto: u.profile_photo || null,
    trustScore: u.trust_score || 100,
    reportCount: u.report_count || 0,
    premiumExpiry: u.premium_expiry || null,
    auraExpiry: u.aura_expiry || null,
  };
};

router.get("/status", authMw, async (req, res) => {
  try {
    if (req.user.guest) {
      return res.status(403).json({ message: "Guests cannot access Lucky Draw" });
    }
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    
    let freeSpinsLeft = 0;
    let spinsUsed = 0;
    const isPremium = !!(
      req.user.is_premium &&
      req.user.premium_expiry &&
      new Date(req.user.premium_expiry) > now
    );
    const maxSpins = isPremium ? 2 : 1;

    if (!req.user.last_claim_date) {
      freeSpinsLeft = maxSpins;
      spinsUsed = 0;
    } else {
      const claimDateStr = new Date(req.user.last_claim_date).toISOString().split("T")[0];
      if (claimDateStr !== todayStr) {
        freeSpinsLeft = maxSpins;
        spinsUsed = 0;
      } else {
        spinsUsed = new Date(req.user.last_claim_date).getUTCSeconds();
        freeSpinsLeft = Math.max(0, maxSpins - spinsUsed);
      }
    }

    res.json({
      freeSpinsLeft,
      spinsUsedToday: spinsUsed,
      maxFreeSpins: maxSpins,
      cost: 10,
      coins: req.user.coins || 0
    });
  } catch (err) {
    console.error("Lucky draw status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/spin", authMw, async (req, res) => {
  try {
    if (req.user.guest) {
      return res.status(403).json({ message: "Guests cannot access Lucky Draw" });
    }
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    
    let freeSpinsLeft = 0;
    let spinsUsed = 0;
    const isPremium = !!(
      req.user.is_premium &&
      req.user.premium_expiry &&
      new Date(req.user.premium_expiry) > now
    );
    const maxSpins = isPremium ? 2 : 1;

    if (!req.user.last_claim_date) {
      freeSpinsLeft = maxSpins;
      spinsUsed = 0;
    } else {
      const claimDateStr = new Date(req.user.last_claim_date).toISOString().split("T")[0];
      if (claimDateStr !== todayStr) {
        freeSpinsLeft = maxSpins;
        spinsUsed = 0;
      } else {
        spinsUsed = new Date(req.user.last_claim_date).getUTCSeconds();
        freeSpinsLeft = Math.max(0, maxSpins - spinsUsed);
      }
    }

    let isFree = false;
    let cost = 10;
    const upd = {};

    if (freeSpinsLeft > 0) {
      isFree = true;
      cost = 0;
      const nextSpinsUsed = spinsUsed + 1;
      const claimDate = new Date();
      claimDate.setUTCSeconds(nextSpinsUsed);
      upd.last_claim_date = claimDate.toISOString();
    } else {
      if ((req.user.coins || 0) < cost) {
        return res.status(400).json({ message: "Not enough coins" });
      }
      upd.coins = req.user.coins - cost;
    }

    // Roll rewards
    const rand = Math.random();
    let reward = null;
    let targetStops = []; // Stops for reels 1, 2, 3

    // Symbols:
    // 0: 🎰 (Jackpot)
    // 1: 👑 (VIP)
    // 2: 🎭 (Theme)
    // 3: 💰 (25 Coins)
    // 4: 🪙 (15 Coins)
    // 5: 🍒 (Cherry)
    // 6: 🍋 (Lemon)
    // 7: 🔔 (Bell)
    // 8: 🍇 (Grape)
    // 9: 😢 (Sad face)

    if (rand < 0.35) {
      // 35% chance: Win 5 coins back
      reward = { type: "coins", amount: 5, label: "Win 5 Coins back! 🪙" };
      upd.coins = (upd.coins !== undefined ? upd.coins : req.user.coins) + 5;
      targetStops = [4, 5, 4];
    } else if (rand < 0.65) {
      // 30% chance: Better luck next time
      reward = { type: "nothing", amount: 0, label: "Better luck next time! 😢" };
      targetStops = [5, 6, 7];
    } else if (rand < 0.80) {
      // 15% chance: Win 15 coins
      reward = { type: "coins", amount: 15, label: "Win 15 Coins! 🪙" };
      upd.coins = (upd.coins !== undefined ? upd.coins : req.user.coins) + 15;
      targetStops = [4, 4, 4];
    } else if (rand < 0.90) {
      // 10% chance: Win 25 coins
      reward = { type: "coins", amount: 25, label: "Win 25 Coins! 🪙" };
      upd.coins = (upd.coins !== undefined ? upd.coins : req.user.coins) + 25;
      targetStops = [3, 3, 3];
    } else if (rand < 0.95) {
      // 5% chance: Win 7 Days Chat Theme
      const themes = ["rose", "passion", "sunset", "serenade", "premium", "purple"];
      const chosenTheme = themes[Math.floor(Math.random() * themes.length)];
      reward = { type: "theme", amount: 7, label: `Win 7 Days of ${chosenTheme.toUpperCase()} Chat Theme! 🎭`, value: chosenTheme };
      upd.chat_theme = chosenTheme;
      upd.theme_expiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      targetStops = [2, 2, 2];
    } else if (rand < 0.99) {
      // 4% chance: Win 7 Days VIP
      reward = { type: "vip", amount: 7, label: "Win 7 Days of VIP Status! 👑" };
      const newExpiry = isPremium 
        ? new Date(new Date(req.user.premium_expiry).getTime() + 7 * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      upd.is_premium = true;
      upd.premium_expiry = newExpiry.toISOString();
      targetStops = [1, 1, 1];
    } else {
      // 1% chance: Jackpot 100 coins
      reward = { type: "coins", amount: 100, label: "💥 JACKPOT! Win 100 Coins! 🪙" };
      upd.coins = (upd.coins !== undefined ? upd.coins : req.user.coins) + 100;
      targetStops = [0, 0, 0];
    }

    const { data: u, error } = await supabase
      .from("users")
      .update(upd)
      .eq("id", req.user.id)
      .select()
      .single();

    if (error) {
      console.error("Save spin error:", error);
      return res.status(500).json({ message: "Draw failed" });
    }

    const cleaned = clean(u);
    cleaned.queueBoostExpiry = u.queue_boost_expiry;
    cleaned.themeExpiry = u.theme_expiry;
    cleaned.chatTheme = u.chat_theme;
    cleaned.profileLockExpiry = u.profile_lock_expiry;
    cleaned.revealLikesExpiry = u.reveal_likes_expiry;
    cleaned.auraExpiry = u.aura_expiry;

    let nextSpinsLeft = 0;
    if (isFree) {
      const updatedSpinsUsed = new Date(u.last_claim_date).getUTCSeconds();
      nextSpinsLeft = Math.max(0, maxSpins - updatedSpinsUsed);
    } else {
      nextSpinsLeft = 0;
    }

    res.json({
      success: true,
      user: cleaned,
      reward,
      targetStops,
      freeSpinsLeft: nextSpinsLeft,
      isFree
    });
  } catch (err) {
    console.error("Lucky draw spin error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
