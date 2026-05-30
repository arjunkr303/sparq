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
app.get('/api/stats',   (_req, res) => res.json({
  onlineNow: io.sockets.sockets.size,
  time: new Date()
}));

setupSocket(io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
