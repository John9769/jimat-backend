// JIMAT Chain Engine v3
// Full chain validation with 2-bill 1-report business logic
// Uses denormalised chainStatus on User model for fast lookups
// isReference logic — first bill hidden, second bill = report

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
  return `${names[month] || month} ${year}`;
};

// ── GET CHAIN STATUS ──────────────────────────────────────
// Uses User.chainStatus (denormalised) for fast check
// Falls back to BillingRecord query if needed
const getChainStatus = async (userId, prisma) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      chainStatus: true,
      lastBillingMonth: true,
      chainBrokenAt: true
    }
  });

  if (!user) throw new Error('User not found');

  // Get latest NON-reference billing record
  const lastRecord = await prisma.billingRecord.findFirst({
    where: { userId, isReference: false },
    orderBy: { billingMonth: 'desc' }
  });

  // No non-reference records = new user = ONBOARD
  if (!lastRecord) {
    // Check if there are ANY records (reference bills from failed onboard)
    const anyRecord = await prisma.billingRecord.findFirst({
      where: { userId },
      orderBy: { billingMonth: 'desc' }
    });

    return {
      status: 'ONBOARD',
      billsRequired: 2,
      lastBillingMonth: anyRecord?.billingMonth || null,
      expectedNextMonth: null,
      monthsLapsed: 0
    };
  }

  const lastMonth = lastRecord.billingMonth;
  const expectedNextMonth = getNextMonth(lastMonth);

  // Chain is determined ONLY by billing month continuity — never by real calendar date
  // User's last saved bill is "current". Next upload must be the month right after it.
  // RESET only happens if user explicitly uploads a non-consecutive month (caught in validateUploadedBills)
  return {
    status: 'MONTHLY',
    billsRequired: 1,
    lastBillingMonth: lastMonth,
    expectedNextMonth,
    monthsLapsed: null
  };
};

// ── UPDATE USER CHAIN STATUS ──────────────────────────────
// Called after bills are saved to DB
// Keeps User.chainStatus denormalised for fast reads
const updateUserChainStatus = async (userId, newStatus, lastBillingMonth, prisma) => {
  await prisma.user.update({
    where: { id: userId },
    data: {
      chainStatus: newStatus,
      lastBillingMonth,
      chainBrokenAt: newStatus === 'RESET' ? new Date() : null
    }
  });
};

// ── VALIDATE UPLOADED BILLS ───────────────────────────────
// THE CRITICAL GATEKEEPER
// Validates months against chain before any DB save
// Returns detailed error with expected vs received months
const validateUploadedBills = async (uploadedMonths, userId, prisma, lang = 'EN') => {
  const sorted = [...uploadedMonths].sort();
  const chainStatus = await getChainStatus(userId, prisma);

  // ── DUPLICATE CHECK ───────────────────────────────────
  // Cannot upload bill already in DB — reference or report
  for (const month of sorted) {
    const existing = await prisma.billingRecord.findFirst({
      where: { userId, billingMonth: month }
    });
    if (existing) {
      return {
        valid: false,
        errorCode: 'DUPLICATE_BILL',
        message: lang === 'BM'
          ? `Bil ${formatMonth(month, 'BM')} sudah dianalisis sebelum ini. Sila muat naik bil yang lebih terkini.`
          : `Bill for ${formatMonth(month, 'EN')} has already been analysed. Please upload a newer bill.`
      };
    }
  }

  // ── ONBOARD VALIDATION ────────────────────────────────
  if (chainStatus.status === 'ONBOARD') {
    if (sorted.length < 2) {
      return {
        valid: false,
        errorCode: 'NEED_TWO_BILLS',
        message: lang === 'BM'
          ? 'Sila muat naik 2 bil TNB berturut-turut untuk bermula. Contoh: Mei + Jun 2026.'
          : 'Please upload 2 consecutive months of TNB bills to get started. Example: May + June 2026.'
      };
    }

    if (getNextMonth(sorted[0]) !== sorted[1]) {
      return {
        valid: false,
        errorCode: 'NOT_CONSECUTIVE',
        message: lang === 'BM'
          ? `Bil mesti berturut-turut. Anda muat naik ${formatMonth(sorted[0], 'BM')} dan ${formatMonth(sorted[1], 'BM')}. Contoh: muat naik Mei + Jun bersama.`
          : `Bills must be consecutive. You uploaded ${formatMonth(sorted[0], 'EN')} and ${formatMonth(sorted[1], 'EN')}. Example: upload May + June together.`
      };
    }

    return {
      valid: true,
      status: 'ONBOARD',
      referenceBill: sorted[0],  // First bill = REFERENCE (hidden)
      reportBill: sorted[1],     // Second bill = REPORT
      latestMonth: sorted[1]
    };
  }

  // ── MONTHLY VALIDATION ────────────────────────────────
  if (chainStatus.status === 'MONTHLY') {
    // Loyal user uploads only 1 bill
    if (sorted.length > 1) {
      return {
        valid: false,
        errorCode: 'ONE_BILL_ONLY',
        message: lang === 'BM'
          ? `Anda hanya perlu muat naik 1 bil — bil ${formatMonth(chainStatus.expectedNextMonth, 'BM')} anda.`
          : `You only need to upload 1 bill — your ${formatMonth(chainStatus.expectedNextMonth, 'EN')} bill.`
      };
    }

    const uploadedMonth = sorted[0];

    // Wrong month
    if (uploadedMonth !== chainStatus.expectedNextMonth) {
      return {
        valid: false,
        errorCode: 'WRONG_MONTH',
        message: lang === 'BM'
          ? `Bil salah! Kami jangkakan bil ${formatMonth(chainStatus.expectedNextMonth, 'BM')} anda. Anda muat naik bil ${formatMonth(uploadedMonth, 'BM')}. Sila muat naik bil yang betul.`
          : `Wrong bill! We expected your ${formatMonth(chainStatus.expectedNextMonth, 'EN')} bill. You uploaded ${formatMonth(uploadedMonth, 'EN')}. Please upload the correct bill.`
      };
    }

    // Reference month for this report = last saved non-reference bill
    return {
      valid: true,
      status: 'MONTHLY',
      referenceBill: chainStatus.lastBillingMonth, // Previous month in DB
      reportBill: uploadedMonth,
      latestMonth: uploadedMonth
    };
  }

  // ── RESET VALIDATION ──────────────────────────────────
  if (chainStatus.status === 'RESET') {
    if (sorted.length < 2) {
      return {
        valid: false,
        errorCode: 'NEED_TWO_BILLS_RESET',
        message: lang === 'BM'
          ? `Rantaian bil anda terputus (bil terakhir: ${formatMonth(chainStatus.lastBillingMonth, 'BM')}). Muat naik 2 bil berturut-turut yang terkini untuk tetapkan semula.`
          : `Your bill chain is broken (last bill: ${formatMonth(chainStatus.lastBillingMonth, 'EN')}). Upload 2 consecutive recent bills to reset.`
      };
    }

    // Must be consecutive
    if (getNextMonth(sorted[0]) !== sorted[1]) {
      return {
        valid: false,
        errorCode: 'NOT_CONSECUTIVE_RESET',
        message: lang === 'BM'
          ? `Bil mesti berturut-turut. Anda muat naik ${formatMonth(sorted[0], 'BM')} dan ${formatMonth(sorted[1], 'BM')}.`
          : `Bills must be consecutive. You uploaded ${formatMonth(sorted[0], 'EN')} and ${formatMonth(sorted[1], 'EN')}.`
      };
    }

    // Must be NEWER than last saved
    if (sorted[1] <= chainStatus.lastBillingMonth) {
      return {
        valid: false,
        errorCode: 'OLD_BILLS',
        message: lang === 'BM'
          ? `Bil ini terlalu lama. Analisis terakhir anda: ${formatMonth(chainStatus.lastBillingMonth, 'BM')}. Sila muat naik bil yang lebih terkini.`
          : `These bills are too old. Your last analysis: ${formatMonth(chainStatus.lastBillingMonth, 'EN')}. Please upload more recent bills.`
      };
    }

    return {
      valid: true,
      status: 'RESET',
      referenceBill: sorted[0],  // First bill = REFERENCE (hidden)
      reportBill: sorted[1],     // Second bill = REPORT
      latestMonth: sorted[1]
    };
  }

  return { valid: false, errorCode: 'UNKNOWN', message: 'Unknown chain status' };
};

// ── DETERMINE isReference ─────────────────────────────────
// For each OCR result — is it the reference or the report?
// ONBOARD/RESET: first bill = reference, second = report
// MONTHLY: uploaded bill = report, previous in DB = reference
const determineRoles = (validationResult, ocrResults) => {
  const sorted = [...ocrResults].sort((a, b) =>
    a.billingMonth.localeCompare(b.billingMonth)
  );

  if (validationResult.status === 'ONBOARD' || validationResult.status === 'RESET') {
    return sorted.map((ocr, index) => ({
      ...ocr,
      isReference: index === 0,        // First = reference (hidden)
      referenceMonth: index === 1 ? sorted[0].billingMonth : null
    }));
  }

  if (validationResult.status === 'MONTHLY') {
    // Only 1 bill uploaded — it is the report
    // Reference = previous month already in DB
    return sorted.map(ocr => ({
      ...ocr,
      isReference: false,
      referenceMonth: validationResult.referenceBill
    }));
  }

  return sorted;
};

// ── PRICING ───────────────────────────────────────────────
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

// ── HELPERS ───────────────────────────────────────────────
const getNextMonth = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
};

const getPreviousMonth = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, '0')}`;
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

// Legacy — kept for backward compat
const validateBillingMonths = (months) => {
  if (months.length < 2) return { valid: false, reason: 'Need at least 2 months' };
  const sorted = [...months].sort();
  if (getNextMonth(sorted[0]) !== sorted[1]) {
    return { valid: false, reason: `Not consecutive: ${sorted[0]} and ${sorted[1]}` };
  }
  return { valid: true, month1: sorted[0], month2: sorted[1] };
};

module.exports = {
  getChainStatus,
  updateUserChainStatus,
  getPricing,
  validateBillingMonths,
  validateUploadedBills,
  determineRoles,
  formatMonth,
  getNextMonth,
  getPreviousMonth,
  getMonthsDiff,
  PRICING
};