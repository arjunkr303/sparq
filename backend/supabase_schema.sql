-- StrangerNear v7 — Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('male','female','other')),
  age INTEGER NOT NULL CHECK (age >= 1),
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
  chat_theme TEXT DEFAULT 'default',
  theme_expiry TIMESTAMPTZ DEFAULT NULL,
  profile_lock_expiry TIMESTAMPTZ DEFAULT NULL,
  queue_boost_expiry TIMESTAMPTZ DEFAULT NULL,
  spotlight_interest TEXT DEFAULT NULL,
  spotlight_expiry TIMESTAMPTZ DEFAULT NULL,
  reveal_likes_expiry TIMESTAMPTZ DEFAULT NULL,
  aura_expiry TIMESTAMPTZ DEFAULT NULL,
  city_lock_expiry TIMESTAMPTZ DEFAULT NULL,
  last_claim_date TIMESTAMPTZ DEFAULT NULL,
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_theme TEXT DEFAULT 'default';
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_expiry TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_lock_expiry TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS queue_boost_expiry TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS spotlight_interest TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS spotlight_expiry TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reveal_likes_expiry TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS aura_expiry TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city_lock_expiry TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_claim_date TIMESTAMPTZ DEFAULT NULL;

CREATE TABLE IF NOT EXISTS user_interactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('superlike', 'compliment')),
  is_anonymous BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_interactions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_interactions' AND policyname='Service full access interactions') THEN
    CREATE POLICY "Service full access interactions" ON user_interactions FOR ALL USING (TRUE);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rematch_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sender_id, receiver_id)
);
ALTER TABLE rematch_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rematch_requests' AND policyname='Service full access rematch') THEN
    CREATE POLICY "Service full access rematch" ON rematch_requests FOR ALL USING (TRUE);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS friend_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  friendship_id UUID NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'text' CHECK (type IN ('text', 'image', 'gif', 'voice')),
  mime_type TEXT DEFAULT NULL,
  duration INTEGER DEFAULT NULL,
  reply_to JSONB DEFAULT NULL,
  message_id TEXT UNIQUE NOT NULL,
  seen BOOLEAN DEFAULT FALSE,
  edited BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_friend_messages_friendship_id ON friend_messages(friendship_id);
ALTER TABLE friend_messages ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='friend_messages' AND policyname='Service full access messages') THEN
    CREATE POLICY "Service full access messages" ON friend_messages FOR ALL USING (TRUE);
  END IF;
END $$;

