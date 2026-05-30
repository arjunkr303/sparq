require('dotenv').config();
const dns       = require('dns');

// Force Node.js to prefer IPv4 DNS resolution over IPv6 to prevent ENETUNREACH errors on networks with no IPv6 access
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/user');
const paymentRoutes = require('./routes/payment_route');
const luckyDrawRoutes = require('./routes/luckyDraw');
const gifsRoutes    = require('./routes/gifs');
const setupSocket   = require('./socket/chat');

const app    = express();
app.set('trust proxy', 1); // Trust first proxy (Render) to resolve X-Forwarded-For client IP correctly
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '15mb' }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 300 }));

app.use('/api/auth',    authRoutes);
app.use('/api/user',    userRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/lucky-draw', luckyDrawRoutes);
app.use('/api/gifs',       gifsRoutes);
app.get('/api/health',  (_req, res) => res.json({ status: 'ok', time: new Date() }));
app.get('/api/config',  (_req, res) => res.json({ glitchtipDsn: process.env.GLITCHTIP_DSN || null }));

// Sentry/GlitchTip Tunnel Proxy to bypass Ad Blockers (ERR_BLOCKED_BY_CLIENT)
app.post('/api/tunnel', express.text({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    const envelope = req.body;
    if (!envelope) return res.status(400).send('Empty envelope');

    const dsn = process.env.GLITCHTIP_DSN;
    if (!dsn) return res.status(500).send('GlitchTip DSN not configured on backend');

    // Parse target host, project ID, and public key from back-end DSN
    const match = dsn.match(/https:\/\/([^@]+)@([^/]+)\/(\d+)/);
    if (!match) return res.status(500).send('Invalid DSN format');

    const publicKey = match[1];
    const host = match[2];
    const projectId = match[3];

    // Proxy raw envelope body to GlitchTip with authentication key
    const upstreamUrl = `https://${host}/api/${projectId}/envelope/?sentry_key=${publicKey}`;
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      body: envelope,
      headers: { 'Content-Type': 'application/x-sentry-envelope' }
    });

    res.status(response.status).end();
  } catch (err) {
    console.error('GlitchTip tunnel proxy error:', err);
    res.status(500).send('Tunnel proxy failed');
  }
});

app.get('/api/stats',   (_req, res) => res.json({
  onlineNow: io.sockets.sockets.size,
  time: new Date()
}));

setupSocket(io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
