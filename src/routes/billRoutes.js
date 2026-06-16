const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  upload,
  saveAppliances,
  getChainInfo,
  uploadBills,
  getBillingHistory
} = require('../controllers/billController');

router.post('/appliances', protect, saveAppliances);
router.get('/chain', protect, getChainInfo);
router.post('/upload', protect, upload.array('bills', 2), uploadBills);
router.get('/history', protect, getBillingHistory);

module.exports = router;