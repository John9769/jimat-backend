const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { createPayment, webhook, checkPaymentStatus } = require('../controllers/paymentController');

// Webhook must be PUBLIC — ToyyibPay calls this directly
router.post('/webhook', webhook);

router.post('/create', protect, createPayment);
router.get('/status/:recordId', protect, checkPaymentStatus);

module.exports = router;