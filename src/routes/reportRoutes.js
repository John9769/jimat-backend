const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getReport, getTeaser } = require('../controllers/reportController');

router.get('/teaser/:recordId', protect, getTeaser);
router.get('/:recordId', protect, getReport);

module.exports = router;