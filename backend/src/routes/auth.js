const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const supabase = require("../supabase");
const disposableDomains = require("disposable-email-domains");
const nodemailer = require("nodemailer");
const router = express.Router();

let dynamicDisposableDomains = [];

// Fetch freshest disposable domains on startup from GitHub
async function loadDynamicBlocklist() {
  try {
    const res = await fetch("https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.json");
    if (res.ok) {
      dynamicDisposableDomains = await res.json();
      console.log(`🌐 Loaded ${dynamicDisposableDomains.length} fresh disposable domains from GitHub.`);
    }
  } catch (err) {
    console.warn("⚠️ Failed to fetch remote disposable email list. Using local offline list.", err.message);
  }
}
loadDynamicBlocklist();

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
} else {
  console.log("ℹ️ SMTP credentials not fully configured in .env. Using simulated console logging for development email verification.");
}

async function sendVerificationMail(email, link) {
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; background: #060610; color: #f0edff; padding: 40px; border-radius: 12px; max-width: 500px; margin: auto; border: 1px solid rgba(139,117,255,0.2);">
      <h2 style="color: #7c5cfc; text-align: center; font-size: 28px; margin-bottom: 20px;">◈ Sparq</h2>
      <p style="font-size: 15px; line-height: 1.6; color: #a99fd4; margin-bottom: 24px;">Thank you for registering on Sparq! Please verify your email address to activate your account and start chatting with strangers.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${link}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #7c5cfc, #22d3ee); color: #ffffff; padding: 14px 32px; border-radius: 50px; font-weight: 700; text-decoration: none; box-shadow: 0 4px 15px rgba(124, 92, 252, 0.4); transition: transform 0.2s; font-family: sans-serif;">Confirm Email Address</a>
      </div>
      <p style="font-size: 12px; color: #6b6390; text-align: center; margin-top: 30px; line-height: 1.5;">If the button doesn't work, copy and paste this link in a new tab:<br><a href="${link}" style="color: #22d3ee; text-decoration: none; word-break: break-all;">${link}</a></p>
    </div>
  `;

  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"Sparq Support" <${process.env.SMTP_FROM || 'no-reply@sparqchat.com'}>`,
        to: email,
        subject: "Confirm your Sparq email address ◈",
        html: htmlContent
      });
    } catch (mailErr) {
      console.error("Nodemailer failed to send email, logging simulated link:", mailErr);
      console.log("\n=======================================================");
      console.log("📨 sparq-dev-mail: SIMULATED VERIFICATION EMAIL SENT (SMTP Error Fallback)!");
      console.log(`To: ${email}`);
      console.log(`Link: ${link}`);
      console.log("=======================================================\n");
    }
  } else {
    console.log("\n=======================================================");
    console.log("📨 sparq-dev-mail: SIMULATED VERIFICATION EMAIL SENT!");
    console.log(`To: ${email}`);
    console.log(`Link: ${link}`);
    console.log("=======================================================\n");
  }
}

const sign = (id, options = {}) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d", ...options });

const DEV_EMAILS = ["arjunsreechakram@gmail.com", "jithubaiju124@gmail.com"];

const clean = (u) => {
  const isDevEmail = u.email && DEV_EMAILS.includes(u.email.toLowerCase());
  const now = new Date();
  
  const isPremium = isDevEmail || !!(u.is_premium && u.premium_expiry && new Date(u.premium_expiry) > now) || u.admin_title === 'vip_monthly' || u.admin_title === 'vip_annual';
  const isPremiumAnnual = isDevEmail || u.admin_title === 'vip_annual';

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
    cityLockExpiry: u.city_lock_expiry || null,
  };
};

// ── check email ──
router.get("/check-email", async (req, res) => {
  try {
    const email = req.query.email || "";
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) {
      return res.json({ taken: false, isDisposable: true });
    }

    // 1. Blocklist check (Local offline list + GitHub remote list)
    const isBlocklisted = disposableDomains.includes(domain) || 
                          dynamicDisposableDomains.includes(domain);
    if (isBlocklisted) {
      return res.json({ taken: false, isDisposable: true });
    }

    // 2. DNS MX Verification (Blocks custom burner domains or unresolvable fake domains)
    const dns = require("dns").promises;
    try {
      const mx = await dns.resolveMx(domain);
      if (!mx || mx.length === 0) {
        return res.json({ taken: false, isDisposable: true });
      }
    } catch {
      return res.json({ taken: false, isDisposable: true });
    }

    const { data } = await supabase
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    res.json({ taken: !!data, isDisposable: false });
  } catch {
    res.json({ taken: false, isDisposable: false });
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

// ── send verification link ──
router.post("/send-verification-link", async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({ message: "Email is required" });
  }

  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    return res.status(400).json({ message: "Invalid email address" });
  }

  // 1. Blocklist check (Local offline list + GitHub remote list)
  const isBlocklisted = disposableDomains.includes(domain) || 
                        dynamicDisposableDomains.includes(domain);
  if (isBlocklisted) {
    return res.status(400).json({ message: "Please enter a secure, permanent email address." });
  }

  // 2. DNS MX Verification
  const dns = require("dns").promises;
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx || mx.length === 0) {
      return res.status(400).json({ message: "Please enter a secure, permanent email address." });
    }
  } catch {
    return res.status(400).json({ message: "Please enter a secure, permanent email address." });
  }

  // 3. Check if email is already registered in supabase users table
  try {
    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered." });
    }

    // 4. Generate verification token (32 character hex)
    const crypto = require("crypto");
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString(); // 20 minutes expiration

    // 5. Upsert verification token in Supabase
    const { error: upsertErr } = await supabase
      .from("email_verification_tokens")
      .upsert(
        { email: email.toLowerCase(), token, verified: false, expires_at: expiresAt },
        { onConflict: "email" }
      );

    if (upsertErr) {
      console.error("Verification token upsert error:", upsertErr);
      return res.status(500).json({ message: "Verification failed. Database error." });
    }

    // 6. Build validation link
    const backendBaseUrl = (req.secure ? "https://" : "http://") + req.headers.host;
    const confirmLink = `${backendBaseUrl}/api/auth/confirm-email?token=${token}`;

    // 7. Send the email!
    await sendVerificationMail(email.toLowerCase(), confirmLink);

    res.json({ success: true, message: "Verification email sent successfully!" });
  } catch (err) {
    console.error("Verification request error:", err);
    res.status(500).json({ message: "Server error during verification request." });
  }
});

// ── confirm email ──
router.get("/confirm-email", async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send("Verification token is required.");
  }

  try {
    // Find the token in the database
    const { data: verToken, error } = await supabase
      .from("email_verification_tokens")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (error || !verToken) {
      return res.status(400).send("Invalid or expired verification token.");
    }

    if (new Date(verToken.expires_at) < new Date()) {
      return res.status(400).send("Verification token has expired. Please request a new one.");
    }

    // Update verified status to true
    const { error: updateErr } = await supabase
      .from("email_verification_tokens")
      .update({ verified: true })
      .eq("id", verToken.id);

    if (updateErr) {
      console.error("Token update error:", updateErr);
      return res.status(500).send("Database error during verification confirmation.");
    }

    // Redirect to the frontend verify-email landing page
    const frontendUrl = process.env.CLIENT_URL || "http://127.0.0.1:5500";
    res.redirect(`${frontendUrl}/frontend/verify-email.html?status=success`);
  } catch (err) {
    console.error("Confirm email error:", err);
    res.status(500).send("Server error during verification confirmation.");
  }
});

// ── check verification status ──
router.get("/check-verification", async (req, res) => {
  const { email } = req.query;
  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const { data: tokenRecord, error } = await supabase
      .from("email_verification_tokens")
      .select("verified, expires_at")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (error || !tokenRecord) {
      return res.json({ verified: false });
    }

    // Check if verified and not expired
    const isVerified = tokenRecord.verified && new Date(tokenRecord.expires_at) > new Date();
    res.json({ verified: !!isVerified });
  } catch (err) {
    console.error("Check verification error:", err);
    res.status(500).json({ message: "Server error checking verification status." });
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

    if (!email || typeof email !== "string") {
      return res.status(400).json({ message: "Email is required" });
    }
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    // 1. Blocklist check (Local offline list + GitHub remote list)
    const isBlocklisted = disposableDomains.includes(domain) || 
                          dynamicDisposableDomains.includes(domain);
    if (isBlocklisted) {
      return res.status(400).json({ message: "Please enter a secure, permanent email address." });
    }

    // 2. DNS MX Verification (Blocks custom burner domains or unresolvable fake domains)
    const dns = require("dns").promises;
    try {
      const mx = await dns.resolveMx(domain);
      if (!mx || mx.length === 0) {
        return res.status(400).json({ message: "Please enter a secure, permanent email address." });
      }
    } catch {
      return res.status(400).json({ message: "Please enter a secure, permanent email address." });
    }

    // 3. Database-enforced Verification Check
    const { data: tokenRecord } = await supabase
      .from("email_verification_tokens")
      .select("verified, expires_at")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    const isVerified = tokenRecord && tokenRecord.verified && new Date(tokenRecord.expires_at) > new Date();
    if (!isVerified) {
      return res.status(400).json({ message: "Please verify your email address before registering." });
    }

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
