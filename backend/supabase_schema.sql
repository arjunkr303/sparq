-- StrangerNear v7 — Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('male','female','other')),
  age INTEGER NOT NULL CHECK (age >= 18),
  country TEXT DEFAULT '',
  state TEXT DEFAULT '',
  city TEXT DEFAULT '',
  interests TEXT[] DEFAULT '{}',
  is_verified BOOLEAN DEFAULT FALSE,
  is_premium BOOLEAN DEFAULT FALSE,
  is_admin BOOLEAN DEFAULT FALSE,
  admin_title TEXT DEFAULT NULL,
  premium_expiry TIMESTAMPTZ DEFAULT NULL,
  coins INTEGER DEFAULT 0,
  trust_score INTEGER DEFAULT 100,
  report_count INTEGER DEFAULT 0,
  is_banned BOOLEAN DEFAULT FALSE,
  ban_expiry TIMESTAMPTZ DEFAULT NULL,
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  two_fa_secret TEXT DEFAULT NULL,
  profile_photo TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='users' AND policyname='Service full access') THEN
    CREATE POLICY "Service full access" ON users FOR ALL USING (TRUE);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS friendships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='friendships' AND policyname='Service full access friends') THEN
    CREATE POLICY "Service full access friends" ON friendships FOR ALL USING (TRUE);
  END IF;
END $$;

-- If upgrading from old schema, add new column:
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT DEFAULT NULL;
