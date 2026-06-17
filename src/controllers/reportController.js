const { PrismaClient } = require('@prisma/client');
const { calculateTNBBill } = require('../engine/tnbEngine');
const { analyseBleeders, generateMissions } = require('../engine/bleederEngine');

const prisma = new PrismaClient();

const rebuildAfaComponents = (record) => {
  try {
    if (record.rawOcrText) {
      const ocr = JSON.parse(record.rawOcrText);
      if (ocr.afaComponents && Array.isArray(ocr.afaComponents) && ocr.afaComponents.length > 0) {
        return ocr.afaComponents;
      }
    }
  } catch (e) {}
  if (record.afaCharge && record.totalKwh > 0) {
    const rateSen = (record.afaCharge / record.totalKwh) * 100;
    return [{ rateSen: Math.round(rateSen * 100) / 100, kwh: record.totalKwh, description: 'AFA', amountMyr: record.afaCharge }];
  }
  return [];
};

const getOcrData = (record) => {
  try {
    if (record.rawOcrText) return JSON.parse(record.rawOcrText);
  } catch (e) {}
  return {};
};

// Get cajSemasa — current month charges only, no arrears
const getCajSemasa = (record) => {
  const ocr = getOcrData(record);
  if (ocr.cajSemasa && ocr.cajSemasa > 0) return ocr.cajSemasa;
  return record.totalAmountMyr || 0;
};

const round2 = (val) => Math.round(val * 100) / 100;

const getNextMonth = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
};

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

    // OCR data — source of truth for Bill Autopsy
    const ocrData = getOcrData(record);

    // Appliances
    const appliances = await prisma.appliance.findMany({
      where: { userId: req.user.id }
    });

    // AFA components from OCR
    const afaComponents = rebuildAfaComponents(record);

    // Admin AFA fallback
    const afaRecord = await prisma.afaRate.findFirst({
      where: { month: record.billingMonth }
    });

    const afaForEngine = afaComponents.length > 0
      ? afaComponents
      : afaRecord
        ? [{ rateSen: afaRecord.rateSen, kwh: record.totalKwh }]
        : [];

    // cajSemasa — actual current month charges from OCR
    const currentCajSemasa = getCajSemasa(record);

    // ── EFFECTIVE RATE — FROM ACTUAL BILL ─────────────────
    // Use cajSemasa ÷ totalKwh = real rate user actually paid
    // NOT engine-calculated — avoids hallucinated figures
    // This is what feeds the bleeder engine
    const actualEffectiveRateSen = record.totalKwh > 0
      ? round2((currentCajSemasa / record.totalKwh) * 100)
      : 0;

    console.log('Effective rate from actual bill:', {
      cajSemasa: currentCajSemasa,
      totalKwh: record.totalKwh,
      effectiveRateSen: actualEffectiveRateSen
    });

    // Engine — only used for flags (aboveThreshold etc)
    // NOT used for effective rate anymore
    const billAnalysis = calculateTNBBill(
      record.totalKwh,
      afaForEngine,
      record.billingPeriodDays || 30
    );

    // Override engine effective rate with actual bill rate
    const engineForBleeder = {
      ...billAnalysis,
      effectiveRateSen: actualEffectiveRateSen
    };

    // ── BLEEDER ENGINE ────────────────────────────────────
    // Uses ACTUAL effective rate from bill — not engine estimate
    let bleederResult = null;
    let missions = [];
    if (appliances.length > 0) {
      bleederResult = analyseBleeders(
        appliances,
        record.totalKwh,
        actualEffectiveRateSen,
        record.billingPeriodDays || 30
      );
      missions = generateMissions(bleederResult, engineForBleeder, req.user.language);
    }

    // ── MONTH VS MONTH ────────────────────────────────────
    // Compare cajSemasa only — NOT totalAmountMyr (includes arrears)
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
      const prevCajSemasa = getCajSemasa(previousRecord);
      const kwhDiff = record.totalKwh - previousRecord.totalKwh;
      const amountDiff = round2(currentCajSemasa - prevCajSemasa);
      const kwhChangePercent = previousRecord.totalKwh > 0
        ? round2((kwhDiff / previousRecord.totalKwh) * 100)
        : 0;

      comparison = {
        currentMonth: record.billingMonth,
        previousMonth: previousRecord.billingMonth,
        currentKwh: record.totalKwh,
        previousKwh: previousRecord.totalKwh,
        currentCajSemasa,
        previousCajSemasa: prevCajSemasa,
        kwhDiff: round2(kwhDiff),
        amountDiff,
        kwhChangePercent,
        improved: kwhDiff < 0,
        thresholdCrossed: {
          retailCharge: previousRecord.totalKwh <= 600 && record.totalKwh > 600,
          eei: false,
          highTier: previousRecord.totalKwh <= 1500 && record.totalKwh > 1500
        }
      };
    }

    // ── AFA WATCH ─────────────────────────────────────────
    const nextMonth = getNextMonth(record.billingMonth);
    const nextAfaRecord = await prisma.afaRate.findFirst({
      where: { month: nextMonth }
    });

    const netAfaRateSen = afaComponents.length > 0
      ? round2(afaComponents.reduce((sum, c) => sum + c.rateSen, 0))
      : afaRecord ? afaRecord.rateSen : 0;

    // ── SAVINGS LEDGER ────────────────────────────────────
    // monthsAnalysed = unlocked records
    // potentialSavingPerMonth = current bleeder total potential saving
    // totalPaidToJimat = actual SUCCESS payments
    // netGainMyr = potential saving minus paid to JIMAT
    const allUnlockedRecords = await prisma.billingRecord.findMany({
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

    const totalPaidToJimat = totalPayments._sum.amountMyr || 0;

    // Potential saving = from bleeder engine (most accurate)
    // If no bleeder, fallback to sum of teaserAmounts
    const potentialSavingPerMonth = bleederResult
      ? round2(bleederResult.totalPotentialSavingMyr)
      : round2(allUnlockedRecords.reduce((sum, r) => sum + (r.teaserAmount || 0), 0) / (allUnlockedRecords.length || 1));

    // Net gain = if user acts on all missions this month, what do they gain vs what they paid JIMAT
    const netGainMyr = round2(Math.max(potentialSavingPerMonth - totalPaidToJimat, 0));

    // ── BILL AUTOPSY FLAGS ────────────────────────────────
    const excessKwh = Math.max(record.totalKwh - 600, 0);
    const flags = {
      retailChargeWaived: excessKwh === 0,
      aboveThreshold: excessKwh > 0,
      aboveHighTier: record.totalKwh > 1500,
      eeiApplied: true,
      nearRetailThreshold: record.totalKwh > 540 && record.totalKwh <= 600,
      excessKwh
    };

    const report = {
      // Screen 1 — Bill Autopsy (100% OCR values)
      billAutopsy: {
        billingMonth: record.billingMonth,
        billingPeriodDays: record.billingPeriodDays || 30,
        billingPeriodStart: ocrData.billingPeriodStart || null,
        billingPeriodEnd: ocrData.billingPeriodEnd || null,
        totalKwh: record.totalKwh,
        cajSemasa: currentCajSemasa,
        totalAmountMyr: ocrData.totalAmountMyr || record.totalAmountMyr,
        tunggakan: ocrData.tunggakan || 0,
        latePaymentCharge: ocrData.latePaymentCharge || 0,
        breakdown: {
          generationCharge: ocrData.generationCharge || record.generationCharge || 0,
          capacityCharge: ocrData.capacityCharge || record.capacityCharge || 0,
          networkCharge: ocrData.networkCharge || record.networkCharge || 0,
          retailCharge: ocrData.retailCharge || record.retailCharge || 0,
          afaCharge: ocrData.afaCharge !== undefined ? ocrData.afaCharge : record.afaCharge || 0,
          afaComponents: ocrData.afaComponents || afaComponents || [],
          eeRebate: ocrData.eeRebate || record.eeRebate || 0,
          kwtbbCharge: ocrData.kwtbbCharge || record.kwtbbCharge || 0,
          sstCharge: ocrData.sstCharge || record.sstCharge || 0,
          latePaymentCharge: ocrData.latePaymentCharge || 0
        },
        flags
      },

      // Screen 2 — Bleeder
      bleeder: bleederResult ? {
        topBleeder: bleederResult.topBleeder,
        allBleeders: bleederResult.bleeders,
        totalPotentialSavingMyr: bleederResult.totalPotentialSavingMyr,
        coveragePercent: bleederResult.coveragePercent,
        effectiveRateSenUsed: actualEffectiveRateSen
      } : null,

      // Screen 3 — Missions
      missions,

      // Screen 4 — Month vs Month
      comparison,

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
        monthsAnalysed: allUnlockedRecords.length,
        potentialSavingPerMonth,
        totalPaidToJimatMyr: round2(totalPaidToJimat),
        netGainMyr,
        history: allUnlockedRecords
      },

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

const getTeaser = async (req, res) => {
  try {
    const { recordId } = req.params;
    const record = await prisma.billingRecord.findFirst({
      where: { id: recordId, userId: req.user.id },
      select: {
        id: true, billingMonth: true, totalKwh: true,
        totalAmountMyr: true, isUnlocked: true, teaserAmount: true
      }
    });
    if (!record) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }
    if (record.isUnlocked) {
      return res.json({ success: true, isUnlocked: true, recordId: record.id, message: 'Report already unlocked' });
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

module.exports = { getReport, getTeaser };