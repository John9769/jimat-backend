const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  upload,
  saveAppliances,
  getChainInfo,
  scanBills,
  confirmBills,
  getBillingHistory
} = require('../controllers/billController');

router.post('/appliances', protect, saveAppliances);
router.get('/chain', protect, getChainInfo);
router.post('/scan', protect, upload.array('bills', 2), scanBills);
router.post('/confirm', protect, confirmBills);
router.get('/history', protect, getBillingHistory);

module.exports = router;