const jwt = require("jsonwebtoken");
const supabase = require("../supabase");

module.exports = async (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer "))
    return res.status(401).json({ message: "Unauthorized" });
  try {
    const { id } = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
    const { data: u } = await supabase
      .from("users")
      .select(
        "id,username,email,gender,age,country,state,city,interests,is_verified,is_premium,premium_expiry,is_admin,admin_title,coins,trust_score,report_count,is_banned,two_fa_enabled,created_at,profile_photo,last_claim_date,aura_expiry,chat_theme,theme_expiry",
      )
      .eq("id", id)
      .maybeSingle();
    if (!u) return res.status(401).json({ message: "User not found" });
    
    // Force VIP / Premium for all users
    u.is_premium = true;
    u.premium_expiry = "2099-12-31T23:59:59.000Z";
    u.is_verified = true;
    
    req.user = u;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
