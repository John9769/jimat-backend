const express = require('express');
const router = express.Router();
const { adminProtect } = require('../middleware/auth');
const {
  adminLogin,
  getDashboardStats,
  getAllUsers,
  toggleUserStatus,
  updateAfaRate,
  getAfaRates
} = require('../controllers/adminController');

router.post('/login', adminLogin);
router.get('/dashboard', adminProtect, getDashboardStats);
router.get('/users', adminProtect, getAllUsers);
router.put('/users/:userId/toggle', adminProtect, toggleUserStatus);
router.post('/afa', adminProtect, updateAfaRate);
router.get('/afa', adminProtect, getAfaRates);

module.exports = router;