// JIMAT Chain Engine
// Validates billing month continuity
// Controls pricing tier based on chain status

const PRICING = {
  HOUSEHOLD: {
    ONBOARD: 11.99,
    MONTHLY: 6.99,
    RESET: 11.99
  },
  INSTITUTIONAL: {
    ONBOARD: 29.99,
    MONTHLY: 14.99,
    RESET: 29.99
  }
};

const getChainStatus = async (userId, prisma) => {
  const records = await prisma.billingRecord.findMany({
    where: { userId },
    orderBy: { billingMonth: 'desc' },
    take: 2
  });

  // No records = new user = ONBOARD
  if (records.length === 0) {
    return {
      status: 'ONBOARD',
      billsRequired: 2,
      lastBillingMonth: null,
      expectedNextMonth: null
    };
  }

  // Has records — check if chain is intact
  const lastRecord = records[0];
  const lastMonth = lastRecord.billingMonth; // YYYY-MM

  const expectedNextMonth = getNextMonth(lastMonth);
  const currentMonth = getCurrentMonth();

  // Chain intact = expected next month matches current month
  if (expectedNextMonth === currentMonth) {
    return {
      status: 'MONTHLY',
      billsRequired: 1,
      lastBillingMonth: lastMonth,
      expectedNextMonth
    };
  }

  // Chain broken = lapsed
  return {
    status: 'RESET',
    billsRequired: 2,
    lastBillingMonth: lastMonth,
    expectedNextMonth,
    monthsLapsed: getMonthsDiff(lastMonth, currentMonth)
  };
};

const getPricing = (userType, chainStatus) => {
  const tier = userType === 'INSTITUTIONAL' ? 'INSTITUTIONAL' : 'HOUSEHOLD';
  const price = PRICING[tier][chainStatus] || PRICING[tier].ONBOARD;
  return {
    price,
    tier,
    chainStatus,
    gatewayFee: 1.00,
    total: price + 1.00
  };
};

const validateBillingMonths = (months) => {
  // months = array of YYYY-MM strings
  if (months.length < 2) return { valid: false, reason: 'Need at least 2 months' };

  const sorted = [...months].sort();
  const first = sorted[0];
  const second = sorted[1];

  if (getNextMonth(first) !== second) {
    return {
      valid: false,
      reason: `Bills must be consecutive months. Got ${first} and ${second}`
    };
  }

  return { valid: true, month1: first, month2: second };
};

// Helpers
const getNextMonth = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
};

const getCurrentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const getMonthsDiff = (from, to) => {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
};

module.exports = { getChainStatus, getPricing, validateBillingMonths, PRICING };