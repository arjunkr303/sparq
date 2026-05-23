const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const supabase = require("../supabase");
const router = express.Router();

const sign = (id, options = {}) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d", ...options });

const DEV_EMAILS = ["arjunsreechakram@gmail.com", "jithubajiu124@gmail.com"];

const clean = (u) => {
  const isDevEmail = u.email && DEV_EMAILS.includes(u.email.toLowerCase());
  const now = new Date();
  const isPremium = isDevEmail || !!(
    u.is_premium &&
    u.premium_expiry &&
    new Date(u.premium_expiry) > now
  );
  const isPremiumAnnual = isDevEmail || !!(
    isPremium &&
    u.premium_expiry &&
    new Date(u.premium_expiry) - now > 35 * 24 * 60 * 60 * 1000
  );

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
    dev: isDevEmail,
  };
};

// ── check email ──
router.get("/check-email", async (req, res) => {
  try {
    const { data } = await supabase
      .from("users")
      .select("id")
      .eq("email", (req.query.email || "").toLowerCase())
      .maybeSingle();
    res.json({ taken: !!data });
  } catch {
    res.json({ taken: false });
  }
});

// ── check username ──
router.get("/check-username", async (req, res) => {
  try {
    const { data } = await supabase
      .from("users")
      .select("id")
      .eq("username", req.query.username || "")
      .maybeSingle();
    res.json({ taken: !!data });
  } catch {
    res.json({ taken: false });
  }
});

// ── register ──
router.post("/register", async (req, res) => {
  try {
    const {
      email,
      password,
      username,
      gender,
      age,
      country,
      state,
      city,
      interests,
      ageConfirmed,
    } = req.body;

    if (!["male", "female", "other"].includes(gender))
      return res.status(400).json({ message: "Invalid gender" });

    const { data: e1 } = await supabase
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (e1)
      return res.status(400).json({ message: "Email already registered" });

    const { data: e2 } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (e2) return res.status(400).json({ message: "Username already taken" });

    const pw = await bcrypt.hash(password, 12);
    const { data: u, error } = await supabase
      .from("users")
      .insert({
        email: email.toLowerCase(),
        password: pw,
        username,
        gender,
        age: age ? parseInt(age) : null,
        country: country || "",
        state: state || "",
        city: city || "",
        interests: interests || [],
        is_verified: false,
        is_premium: false,
        is_admin: false,
        admin_title: null,
        coins: 0,
        trust_score: 100,
        report_count: 0,
        is_banned: false,
        two_fa_enabled: false,
        two_fa_secret: null,
        profile_photo: null,
      })
      .select()
      .single();

    if (error) {
      console.error("Register error:", error);
      return res
        .status(500)
        .json({ message: "Registration failed: " + error.message });
    }

    res.status(201).json({ token: sign(u.id), user: clean(u) });
  } catch (err) {
    console.error("Register catch:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── login ──
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const { data: u, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (error) console.error("Login DB error:", error);
    if (!u)
      return res.status(401).json({ message: "Invalid email or password" });

    const valid = await bcrypt.compare(password, u.password);
    if (!valid)
      return res.status(401).json({ message: "Invalid email or password" });

    if (u.is_banned) {
      if (!u.ban_expiry || new Date(u.ban_expiry) > new Date())
        return res
          .status(403)
          .json({ message: "Account suspended. Contact support." });
      await supabase.from("users").update({ is_banned: false }).eq("id", u.id);
    }

    res.json({ token: sign(u.id), user: clean(u) });
  } catch (err) {
    console.error("Login catch:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
