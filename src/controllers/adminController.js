const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

// Admin login
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({ success: true, token, admin: { id: admin.id, email: admin.email, name: admin.name } });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
};

// Dashboard stats
const getDashboardStats = async (req, res) => {
  try {
    const [
      totalUsers,
      householdUsers,
      institutionalUsers,
      totalPayments,
      successPayments,
      totalBills,
      unlockedBills
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { userType: 'HOUSEHOLD' } }),
      prisma.user.count({ where: { userType: 'INSTITUTIONAL' } }),
      prisma.payment.count(),
      prisma.payment.count({ where: { status: 'SUCCESS' } }),
      prisma.billingRecord.count(),
      prisma.billingRecord.count({ where: { isUnlocked: true } })
    ]);

    const revenue = await prisma.payment.aggregate({
      where: { status: 'SUCCESS' },
      _sum: { amountMyr: true }
    });

    // Recent payments
    const recentPayments = await prisma.payment.findMany({
      where: { status: 'SUCCESS' },
      orderBy: { paidAt: 'desc' },
      take: 10,
      include: {
        user: { select: { name: true, email: true, userType: true } }
      }
    });

    res.json({
      success: true,
      stats: {
        totalUsers,
        householdUsers,
        institutionalUsers,
        totalPayments,
        successPayments,
        totalBills,
        unlockedBills,
        totalRevenueMyr: Math.round((revenue._sum.amountMyr || 0) * 100) / 100
      },
      recentPayments
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to get stats' });
  }
};

// Get all users
const getAllUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        userType: true,
        orgName: true,
        township: true,
        state: true,
        isActive: true,
        createdAt: true,
        _count: {
          select: {
            billingRecords: true,
            payments: true
          }
        }
      }
    });

    res.json({ success: true, users });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ success: false, message: 'Failed to get users' });
  }
};

// Toggle user active status
const toggleUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isActive: !user.isActive }
    });

    res.json({
      success: true,
      message: `User ${updated.isActive ? 'activated' : 'deactivated'}`,
      isActive: updated.isActive
    });
  } catch (error) {
    console.error('Toggle user status error:', error);
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
};

// Update AFA rate — admin only
const updateAfaRate = async (req, res) => {
  try {
    const { month, rateSen, note } = req.body;

    if (!month || rateSen === undefined) {
      return res.status(400).json({ success: false, message: 'month and rateSen required' });
    }

    const afa = await prisma.afaRate.upsert({
      where: { month },
      update: { rateSen: parseFloat(rateSen), note: note || null },
      create: { month, rateSen: parseFloat(rateSen), note: note || null }
    });

    res.json({ success: true, message: 'AFA rate updated', afa });
  } catch (error) {
    console.error('Update AFA rate error:', error);
    res.status(500).json({ success: false, message: 'Failed to update AFA rate' });
  }
};

// Get all AFA rates
const getAfaRates = async (req, res) => {
  try {
    const rates = await prisma.afaRate.findMany({
      orderBy: { month: 'desc' }
    });

    res.json({ success: true, rates });
  } catch (error) {
    console.error('Get AFA rates error:', error);
    res.status(500).json({ success: false, message: 'Failed to get AFA rates' });
  }
};

module.exports = {
  adminLogin,
  getDashboardStats,
  getAllUsers,
  toggleUserStatus,
  updateAfaRate,
  getAfaRates
};