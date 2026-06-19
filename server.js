const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// ── CRITICAL: Webhook route needs raw urlencoded parser BEFORE json parser ──
// ToyyibPay sends webhook as application/x-www-form-urlencoded
// Must be registered BEFORE express.json() to avoid conflicts
app.use('/api/payment/webhook', (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      // Parse multipart form data manually — extract key=value pairs
      const boundary = contentType.split('boundary=')[1];
      if (boundary) {
        const parts = body.split('--' + boundary);
        req.body = {};
        parts.forEach(part => {
          const match = part.match(/Content-Disposition: form-data; name="([^"]+)"\r\n\r\n([^\r\n]*)/);
          if (match) req.body[match[1]] = match[2];
        });
      }
      next();
    });
  } else {
    express.urlencoded({ extended: true, limit: '10mb' })(req, res, next);
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
const authRoutes = require('./src/routes/authRoutes');
const billRoutes = require('./src/routes/billRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const adminRoutes = require('./src/routes/adminRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/bill', billRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'JIMAT API Running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`JIMAT Backend running on port ${PORT}`);
});