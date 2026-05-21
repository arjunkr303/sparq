require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/user');
const paymentRoutes = require('./routes/payment');
const luckyDrawRoutes = require('./routes/luckyDraw');
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
app.get('/api/health',  (_req, res) => res.json({ status: 'ok', time: new Date() }));

setupSocket(io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
