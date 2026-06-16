// JIMAT Chain Engine v2
// Full chain validation with wrong bill detection
// and detailed user-facing error messages

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

const MONTH_NAMES_EN = {
  '01': 'January', '02': 'February', '03': 'March',
  '04': 'April', '05': 'May', '06': 'June',
  '07': 'July', '08': 'August', '09': 'September',
  '10': 'October', '11': 'November', '12': 'December'
};

const MONTH_NAMES_BM = {
  '01': 'Januari', '02': 'Februari', '03': 'Mac',
  '04': 'April', '05': 'Mei', '06': 'Jun',
  '07': 'Julai', '08': 'Ogos', '09': 'September',
  '10': 'Oktober', '11': 'November', '12': 'Disember'
};

const formatMonth = (yearMonth, lang = 'EN') => {
  if (!yearMonth) return '';
  const [year, month] = yearMonth.split('-');
  const names = lang === 'BM' ? MONTH_NAMES_BM : MONTH_NAMES_EN;
  return `${names[month]} ${year}`;
};

// Get current chain status for user
const getChainStatus = async (userId, prisma) => {
  const records = await prisma.billingRecord.findMany({
    where: { userId },
    orderBy: { billingMonth: 'desc' },
    take: 1
  });

  // No records = new user = ONBOARD
  if (records.length === 0) {
    return {
      status: 'ONBOARD',
      billsRequired: 2,
      lastBillingMonth: null,
      expectedNextMonth: null,
      monthsLapsed: 0
    };
  }

  const lastRecord = records[0];
  const lastMonth = lastRecord.billingMonth;
  const expectedNextMonth = getNextMonth(lastMonth);
  const currentMonth = getCurrentMonth();
  const monthsLapsed = getMonthsDiff(lastMonth, currentMonth);

  // Chain intact = last saved + 1 = current month
  // Allow 1 month grace (current or previous month upload)
  if (monthsLapsed === 1) {
    return {
      status: 'MONTHLY',
      billsRequired: 1,
      lastBillingMonth: lastMonth,
      expectedNextMonth,
      monthsLapsed: 1
    };
  }

  // Chain broken — lapsed more than 1 month
  return {
    status: 'RESET',
    billsRequired: 2,
    lastBillingMonth: lastMonth,
    expectedNextMonth,
    monthsLapsed
  };
};

// Validate uploaded bill months against chain
// This is the CRITICAL function — prevents wrong bills
const validateUploadedBills = async (uploadedMonths, userId, prisma, lang = 'EN') => {
  const sorted = [...uploadedMonths].sort();

  // Get chain status
  const chainStatus = await getChainStatus(userId, prisma);

  // Check for duplicate bills — already in DB
  for (const month of sorted) {
    const existing = await prisma.billingRecord.findFirst({
      where: { userId, billingMonth: month }
    });
    if (existing) {
      return {
        valid: false,
        errorCode: 'DUPLICATE_BILL',
        message: {
          EN: `Bill for ${formatMonth(month, 'EN')} has already been analysed. Please upload a newer bill.`,
          BM: `Bil untuk ${formatMonth(month, 'BM')} telah dianalisis sebelum ini. Sila muat naik bil yang lebih terkini.`
        }[lang]
      };
    }
  }

  if (chainStatus.status === 'ONBOARD') {
    // New user — need 2 consecutive bills
    if (sorted.length < 2) {
      return {
        valid: false,
        errorCode: 'NEED_TWO_BILLS',
        message: {
          EN: 'Please upload 2 consecutive months of TNB bills to get started.',
          BM: 'Sila muat naik 2 bil TNB berturut-turut untuk bermula.'
        }[lang]
      };
    }

    // Validate consecutive
    if (getNextMonth(sorted[0]) !== sorted[1]) {
      return {
        valid: false,
        errorCode: 'NOT_CONSECUTIVE',
        message: {
          EN: `Bills must be consecutive months. You uploaded ${formatMonth(sorted[0], 'EN')} and ${formatMonth(sorted[1], 'EN')}. Example: upload May + June together.`,
          BM: `Bil mesti bulan berturut-turut. Anda muat naik ${formatMonth(sorted[0], 'BM')} dan ${formatMonth(sorted[1], 'BM')}. Contoh: muat naik Mei + Jun bersama.`
        }[lang]
      };
    }

    return {
      valid: true,
      status: 'ONBOARD',
      month1: sorted[0],
      month2: sorted[1],
      latestMonth: sorted[1]
    };
  }

  if (chainStatus.status === 'MONTHLY') {
    // Loyal user — need exactly 1 bill = expectedNextMonth
    if (sorted.length !== 1) {
      return {
        valid: false,
        errorCode: 'ONE_BILL_ONLY',
        message: {
          EN: `You only need to upload 1 bill — your ${formatMonth(chainStatus.expectedNextMonth, 'EN')} bill.`,
          BM: `Anda hanya perlu muat naik 1 bil — bil ${formatMonth(chainStatus.expectedNextMonth, 'BM')} anda.`
        }[lang]
      };
    }

    const uploadedMonth = sorted[0];

    // Wrong month uploaded
    if (uploadedMonth !== chainStatus.expectedNextMonth) {
      return {
        valid: false,
        errorCode: 'WRONG_MONTH',
        message: {
          EN: `Wrong bill uploaded! We expected your ${formatMonth(chainStatus.expectedNextMonth, 'EN')} bill. You uploaded a ${formatMonth(uploadedMonth, 'EN')} bill. Please upload the correct bill.`,
          BM: `Bil salah dimuat naik! Kami jangkakan bil ${formatMonth(chainStatus.expectedNextMonth, 'BM')} anda. Anda muat naik bil ${formatMonth(uploadedMonth, 'BM')}. Sila muat naik bil yang betul.`
        }[lang]
      };
    }

    return {
      valid: true,
      status: 'MONTHLY',
      month1: uploadedMonth,
      latestMonth: uploadedMonth
    };
  }

  if (chainStatus.status === 'RESET') {
    // Lapsed user — need 2 consecutive bills NEWER than last saved
    if (sorted.length < 2) {
      return {
        valid: false,
        errorCode: 'NEED_TWO_BILLS_RESET',
        message: {
          EN: `Your bill chain is broken (last bill: ${formatMonth(chainStatus.lastBillingMonth, 'EN')}). Please upload 2 consecutive recent bills to reset.`,
          BM: `Rantaian bil anda terputus (bil terakhir: ${formatMonth(chainStatus.lastBillingMonth, 'BM')}). Sila muat naik 2 bil terkini berturut-turut untuk tetapkan semula.`
        }[lang]
      };
    }

    // Bills must be consecutive
    if (getNextMonth(sorted[0]) !== sorted[1]) {
      return {
        valid: false,
        errorCode: 'NOT_CONSECUTIVE_RESET',
        message: {
          EN: `Bills must be consecutive months. You uploaded ${formatMonth(sorted[0], 'EN')} and ${formatMonth(sorted[1], 'EN')}. Please upload 2 consecutive months.`,
          BM: `Bil mesti bulan berturut-turut. Anda muat naik ${formatMonth(sorted[0], 'BM')} dan ${formatMonth(sorted[1], 'BM')}. Sila muat naik 2 bulan berturut-turut.`
        }[lang]
      };
    }

    // Bills must be NEWER than last saved month
    if (sorted[1] <= chainStatus.lastBillingMonth) {
      return {
        valid: false,
        errorCode: 'OLD_BILLS',
        message: {
          EN: `These bills are too old. Your last analysis was ${formatMonth(chainStatus.lastBillingMonth, 'EN')}. Please upload more recent bills.`,
          BM: `Bil-bil ini terlalu lama. Analisis terakhir anda adalah ${formatMonth(chainStatus.lastBillingMonth, 'BM')}. Sila muat naik bil yang lebih terkini.`
        }[lang]
      };
    }

    return {
      valid: true,
      status: 'RESET',
      month1: sorted[0],
      month2: sorted[1],
      latestMonth: sorted[1]
    };
  }

  return { valid: false, errorCode: 'UNKNOWN', message: 'Unknown chain status' };
};

const getPricing = (userType, chainStatus) => {
  const tier = userType === 'INSTITUTIONAL' ? 'INSTITUTIONAL' : 'HOUSEHOLD';
  const price = PRICING[tier][chainStatus] || PRICING[tier].ONBOARD;
  return {
    price,
    tier,
    chainStatus,
    gatewayFee: 1.00,
    total: Math.round((price + 1.00) * 100) / 100
  };
};

// Legacy function — kept for backward compat
const validateBillingMonths = (months) => {
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

const getPreviousMonth = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, '0')}`;
};

module.exports = {
  getChainStatus,
  getPricing,
  validateBillingMonths,
  validateUploadedBills,
  formatMonth,
  PRICING
};