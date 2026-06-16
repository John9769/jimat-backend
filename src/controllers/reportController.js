const { PrismaClient } = require('@prisma/client');
const { calculateTNBBill, compareBills } = require('../engine/tnbEngine');
const { analyseBleeders, generateMissions } = require('../engine/bleederEngine');

const prisma = new PrismaClient();

// Rebuild AFA components from stored raw OCR data
const rebuildAfaComponents = (record) => {
  try {
    // Try to get AFA components from stored rawOcrText
    if (record.rawOcrText) {
      const ocr = JSON.parse(record.rawOcrText);
      if (ocr.afaComponents && Array.isArray(ocr.afaComponents) && ocr.afaComponents.length > 0) {
        return ocr.afaComponents;
      }
    }
  } catch (e) {
    // ignore parse errors
  }

  // Fallback — reconstruct from stored afaCharge
  if (record.afaCharge && record.totalKwh > 0) {
    const rateSen = (record.afaCharge / record.totalKwh) * 100;
    return [{ rateSen: Math.round(rateSen * 100) / 100, kwh: record.totalKwh, description: 'AFA', amountMyr: record.afaCharge }];
  }

  return [];
};

const round2 = (val) => Math.round(val * 100) / 100;

// Get full unlocked report
const getReport = async (req, res) => {
  try {
    const { recordId } = req.params;

    const record = await prisma.billingRecord.findFirst({
      where: { id: recordId, userId: req.user.id }
    });

    if (!record) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }

    if (!record.isUnlocked) {
      return res.status(403).json({
        success: false,
        message: 'Report locked. Payment required.',
        teaserAmount: record.teaserAmount
      });
    }

    // Get appliances
    const appliances = await prisma.appliance.findMany({
      where: { userId: req.user.id }
    });

    // Rebuild AFA components from stored OCR data
    const afaComponents = rebuildAfaComponents(record);

    // Get admin AFA rate as fallback
    const afaRecord = await prisma.afaRate.findFirst({
      where: { month: record.billingMonth }
    });

    // Use OCR AFA components if available, else use admin rate
    const afaForEngine = afaComponents.length > 0
      ? afaComponents
      : afaRecord
        ? [{ rateSen: afaRecord.rateSen, kwh: record.totalKwh, description: 'AFA', amountMyr: record.totalKwh * (afaRecord.rateSen / 100) }]
        : [];

    // Recalculate fresh with correct AFA
    const billAnalysis = calculateTNBBill(
      record.totalKwh,
      afaForEngine,
      record.billingPeriodDays || 30
    );

    // Bleeder analysis
    let bleederResult = null;
    let missions = [];
    if (appliances.length > 0) {
      bleederResult = analyseBleeders(
        appliances,
        record.totalKwh,
        billAnalysis.effectiveRateSen,
        record.billingPeriodDays || 30
      );
      missions = generateMissions(bleederResult, billAnalysis, req.user.language);
    }

    // Get previous record for comparison
    const previousRecord = await prisma.billingRecord.findFirst({
      where: {
        userId: req.user.id,
        billingMonth: { lt: record.billingMonth },
        isUnlocked: true
      },
      orderBy: { billingMonth: 'desc' }
    });

    let comparison = null;
    if (previousRecord) {
      const prevAfaComponents = rebuildAfaComponents(previousRecord);
      const prevAfaRecord = await prisma.afaRate.findFirst({
        where: { month: previousRecord.billingMonth }
      });
      const prevAfaForEngine = prevAfaComponents.length > 0
        ? prevAfaComponents
        : prevAfaRecord
          ? [{ rateSen: prevAfaRecord.rateSen, kwh: previousRecord.totalKwh }]
          : [];

      const previousBillAnalysis = calculateTNBBill(
        previousRecord.totalKwh,
        prevAfaForEngine,
        previousRecord.billingPeriodDays || 30
      );
      comparison = compareBills(billAnalysis, previousBillAnalysis);
    }

    // AFA Watch — next month
    const nextMonth = getNextMonth(record.billingMonth);
    const nextAfaRecord = await prisma.afaRate.findFirst({
      where: { month: nextMonth }
    });

    // Savings ledger
    const allRecords = await prisma.billingRecord.findMany({
      where: { userId: req.user.id, isUnlocked: true },
      orderBy: { billingMonth: 'asc' },
      select: {
        billingMonth: true,
        totalKwh: true,
        totalAmountMyr: true,
        teaserAmount: true
      }
    });

    const totalPayments = await prisma.payment.aggregate({
      where: { userId: req.user.id, status: 'SUCCESS' },
      _sum: { amountMyr: true }
    });

    const totalPotentialSaved = allRecords.reduce((sum, r) => sum + (r.teaserAmount || 0), 0);
    const totalPaidToJimat = totalPayments._sum.amountMyr || 0;

    // Calculate net AFA rate for display
    const netAfaRateSen = afaComponents.length > 0
      ? afaComponents.reduce((sum, c) => sum + c.rateSen, 0)
      : afaRecord ? afaRecord.rateSen : 0;

    // Build full report
    const report = {
      // Screen 1 — Bill Autopsy
      billAutopsy: {
        billingMonth: record.billingMonth,
        billingPeriodDays: record.billingPeriodDays || 30,
        totalKwh: record.totalKwh,
        totalAmountMyr: record.totalAmountMyr,
        breakdown: {
          generationCharge: billAnalysis.generationCharge,
          capacityCharge: billAnalysis.capacityCharge,
          networkCharge: billAnalysis.networkCharge,
          retailCharge: billAnalysis.retailCharge,
          afaCharge: billAnalysis.afaCharge,
          afaComponents: afaComponents,
          eeRebate: billAnalysis.eeRebate,
          kwtbbCharge: billAnalysis.kwtbbCharge,
          sstCharge: billAnalysis.sstCharge
        },
        effectiveRateSen: billAnalysis.effectiveRateSen,
        calculatedTotal: billAnalysis.totalBill,
        flags: billAnalysis.flags,
        // Accuracy check
        accuracy: {
          calculated: billAnalysis.totalBill,
          actual: record.totalAmountMyr,
          difference: round2(Math.abs(billAnalysis.totalBill - record.totalAmountMyr)),
          percentDiff: record.totalAmountMyr > 0
            ? round2(Math.abs((billAnalysis.totalBill - record.totalAmountMyr) / record.totalAmountMyr) * 100)
            : 0
        }
      },

      // Screen 2 — The Bleeder
      bleeder: bleederResult ? {
        topBleeder: bleederResult.topBleeder,
        allBleeders: bleederResult.bleeders,
        totalPotentialSavingMyr: bleederResult.totalPotentialSavingMyr,
        coveragePercent: bleederResult.coveragePercent
      } : null,

      // Screen 3 — Monthly Missions
      missions,

      // Screen 4 — Month vs Month
      comparison: comparison ? {
        currentMonth: record.billingMonth,
        previousMonth: previousRecord?.billingMonth || null,
        currentKwh: record.totalKwh,
        previousKwh: previousRecord?.totalKwh || null,
        kwhDiff: comparison.kwhDiff,
        amountDiff: comparison.amountDiff,
        kwhChangePercent: comparison.kwhChangePercent,
        improved: comparison.improved,
        thresholdCrossed: comparison.thresholdCrossed
      } : null,

      // Screen 5 — AFA Watch
      afaWatch: {
        currentMonth: record.billingMonth,
        currentAfaRateSen: netAfaRateSen,
        currentAfaComponents: afaComponents,
        nextMonth,
        nextAfaRateSen: nextAfaRecord ? nextAfaRecord.rateSen : null,
        nextAfaAvailable: !!nextAfaRecord,
        impactOnBillMyr: nextAfaRecord
          ? round2(record.totalKwh * (nextAfaRecord.rateSen / 100))
          : null,
        userExempt: record.totalKwh <= 600
      },

      // Savings Ledger
      savingsLedger: {
        monthsOnJimat: allRecords.length,
        totalPotentialSavedMyr: round2(totalPotentialSaved),
        totalPaidToJimatMyr: round2(totalPaidToJimat),
        netGainMyr: round2(totalPotentialSaved - totalPaidToJimat),
        history: allRecords
      },

      // Disclaimer
      disclaimer: {
        EN: 'This analysis is based on your declared appliance usage and TNB published tariff rates. Actual savings may vary depending on real usage patterns. AWAS Premium Resources does not guarantee specific bill reductions.',
        BM: 'Analisis ini berdasarkan penggunaan peralatan yang anda isytiharkan dan kadar tarif TNB yang diterbitkan. Penjimatan sebenar mungkin berbeza bergantung kepada corak penggunaan sebenar. AWAS Premium Resources tidak menjamin pengurangan bil yang spesifik.'
      }
    };

    res.json({ success: true, report });
  } catch (error) {
    console.error('Get report error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
};

// Get teaser only — pre-payment
const getTeaser = async (req, res) => {
  try {
    const { recordId } = req.params;

    const record = await prisma.billingRecord.findFirst({
      where: { id: recordId, userId: req.user.id },
      select: {
        id: true,
        billingMonth: true,
        totalKwh: true,
        totalAmountMyr: true,
        isUnlocked: true,
        teaserAmount: true
      }
    });

    if (!record) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }

    if (record.isUnlocked) {
      return res.json({
        success: true,
        isUnlocked: true,
        recordId: record.id,
        message: 'Report already unlocked'
      });
    }

    res.json({
      success: true,
      isUnlocked: false,
      teaser: {
        recordId: record.id,
        billingMonth: record.billingMonth,
        totalKwh: record.totalKwh,
        totalAmountMyr: record.totalAmountMyr,
        estimatedOverspendMyr: record.teaserAmount
      }
    });
  } catch (error) {
    console.error('Get teaser error:', error);
    res.status(500).json({ success: false, message: 'Failed to get teaser' });
  }
};

const getNextMonth = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
};

module.exports = { getReport, getTeaser };