const { PrismaClient } = require('@prisma/client');
const { calculateTNBBill } = require('../engine/tnbEngine');
const { analyseBleeders, generateMissions, generateInstitutionalProfile, calculateInstitutionalWaste } = require('../engine/bleederEngine');
const { calculateHealthScore, calculateMissionTarget } = require('../engine/healthEngine');

const prisma = new PrismaClient();

const round2 = (val) => Math.round(val * 100) / 100;

const getNextMonth = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
};

const getOcrData = (record) => {
  try {
    if (record.rawOcrText) return JSON.parse(record.rawOcrText);
  } catch (e) {}
  return {};
};

const getCajSemasa = (record) => {
  const ocr = getOcrData(record);
  if (ocr.cajSemasa && ocr.cajSemasa > 0) return ocr.cajSemasa;
  if (record.cajSemasa && record.cajSemasa > 0) return record.cajSemasa;
  return record.totalAmountMyr || 0;
};

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

// ── GET REPORT ────────────────────────────────────────────
const getReport = async (req, res) => {
  try {
    const { recordId } = req.params;

    const record = await prisma.billingRecord.findFirst({
      where: {
        id: recordId,
        userId: req.user.id,
        isReference: false
      }
    });

    if (!record) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }

    if (!record.isUnlocked) {
      return res.status(403).json({
        success: false,
        message: 'Report locked. Payment required.',
        teaserLow: record.teaserLow,
        teaserHigh: record.teaserHigh,
        healthScore: record.healthScore,
        healthBand: record.healthBand
      });
    }

    const ocrData = getOcrData(record);

    const appliances = await prisma.appliance.findMany({
      where: { userId: req.user.id }
    });

    const afaComponents = rebuildAfaComponents(record);

    const afaRecord = await prisma.afaRate.findFirst({
      where: { month: record.billingMonth }
    });

    const afaForEngine = afaComponents.length > 0
      ? afaComponents
      : afaRecord
        ? [{ rateSen: afaRecord.rateSen, kwh: record.totalKwh }]
        : [];

    const currentCajSemasa = getCajSemasa(record);

    const actualEffectiveRateSen = record.totalKwh > 0
      ? round2((currentCajSemasa / record.totalKwh) * 100)
      : 0;

    const billAnalysis = calculateTNBBill(
      record.totalKwh,
      afaForEngine,
      record.billingPeriodDays || 30
    );

    // ── BLEEDER ENGINE ────────────────────────────────────
    let appliancesToUse = appliances;
    if (req.user.userType === 'INSTITUTIONAL' && appliances.length === 0) {
      appliancesToUse = generateInstitutionalProfile(req.user);
    }

    let bleederResult = null;
    let missions = [];
    let institutionalWaste = null;

    if (appliancesToUse.length > 0) {
      bleederResult = analyseBleeders(
        appliancesToUse,
        record.totalKwh,
        actualEffectiveRateSen,
        record.billingPeriodDays || 30
      );
      const missionResult = generateMissions(bleederResult, {
        ...billAnalysis,
        effectiveRateSen: actualEffectiveRateSen
      }, req.user.language);
      missions = missionResult;
    }

    if (req.user.userType === 'INSTITUTIONAL' && appliancesToUse.length > 0) {
      institutionalWaste = calculateInstitutionalWaste(
        appliancesToUse,
        record.totalKwh,
        actualEffectiveRateSen,
        record.billingPeriodDays || 30
      );
    }

    // ── REFERENCE RECORD ──────────────────────────────────
    let referenceRecord = null;
    const referenceMonth = record.referenceMonth;

    if (referenceMonth) {
      referenceRecord = await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: referenceMonth }
      });
    }

    if (!referenceRecord) {
      referenceRecord = await prisma.billingRecord.findFirst({
        where: {
          userId: req.user.id,
          billingMonth: { lt: record.billingMonth }
        },
        orderBy: { billingMonth: 'desc' }
      });
    }

    // ── MONTH VS MONTH ────────────────────────────────────
    let comparison = null;
    let referenceCajSemasa = null;
    let referenceAfaCharge = null;

    if (referenceRecord) {
      referenceCajSemasa = getCajSemasa(referenceRecord);
      const referenceOcr = getOcrData(referenceRecord);
      referenceAfaCharge = referenceOcr.afaCharge || referenceRecord.afaCharge || 0;

      const kwhDiff = record.totalKwh - referenceRecord.totalKwh;
      const amountDiff = round2(currentCajSemasa - referenceCajSemasa);
      const kwhChangePercent = referenceRecord.totalKwh > 0
        ? round2((kwhDiff / referenceRecord.totalKwh) * 100)
        : 0;

      const currentAfaCharge = ocrData.afaCharge || record.afaCharge || 0;
      const afaChange = round2(currentAfaCharge);
      const behaviourChange = round2(amountDiff - afaChange);

      comparison = {
        currentMonth: record.billingMonth,
        referenceMonth: referenceRecord.billingMonth,
        currentKwh: record.totalKwh,
        referenceKwh: referenceRecord.totalKwh,
        currentCajSemasa,
        referenceCajSemasa,
        kwhDiff: round2(kwhDiff),
        amountDiff,
        kwhChangePercent,
        improved: kwhDiff < 0,
        afaStory: {
          currentAfaCharge,
          referenceAfaCharge,
          afaChange,
          behaviourChange,
          behaviourImproved: behaviourChange <= 0,
          billUpButBehaviourOk: amountDiff > 0 && behaviourChange <= 0,
          explanation: buildAfaStoryExplanation(
            amountDiff, afaChange, behaviourChange,
            req.user.language || 'EN'
          )
        },
        thresholdCrossed: {
          retailCharge: referenceRecord.totalKwh <= 600 && record.totalKwh > 600,
          highTier: referenceRecord.totalKwh <= 1500 && record.totalKwh > 1500
        }
      };
    }

    // ── MISSION COMPLETION ────────────────────────────────
    let missionCompletion = null;
    if (referenceRecord && referenceRecord.missionKwhTarget) {
      missionCompletion = {
        previousMonth: referenceRecord.billingMonth,
        targetKwh: referenceRecord.missionKwhTarget,
        actualKwh: record.totalKwh,
        completed: record.totalKwh <= referenceRecord.missionKwhTarget,
        savingAchievedMyr: referenceRecord.missionKwhTarget > record.totalKwh
          ? round2((referenceRecord.missionKwhTarget - record.totalKwh) * (actualEffectiveRateSen / 100))
          : 0
      };
    }

    // ── HEALTH SCORE ──────────────────────────────────────
    const healthResult = calculateHealthScore({
      currentKwh: record.totalKwh,
      previousKwh: referenceRecord?.totalKwh || null,
      currentCajSemasa,
      previousCajSemasa: referenceCajSemasa,
      currentAfaCharge: ocrData.afaCharge || record.afaCharge || 0,
      previousAfaCharge: referenceAfaCharge,
      bleederResult,
      lang: req.user.language || 'EN'
    });

    const missionKwhTarget = record.missionKwhTarget || calculateMissionTarget(record.totalKwh);

    // ── AFA WATCH ─────────────────────────────────────────
    const nextMonth = getNextMonth(record.billingMonth);
    const nextAfaRecord = await prisma.afaRate.findFirst({
      where: { month: nextMonth }
    });

    const netAfaRateSen = afaComponents.length > 0
      ? round2(afaComponents.reduce((sum, c) => sum + c.rateSen, 0))
      : afaRecord ? afaRecord.rateSen : 0;

    // ── SAVINGS LEDGER — SIMPLIFIED ───────────────────────
    // Show: potential saving + months analysed only
    // Removed: totalPaidToJimat, netGain (confusing users)
    const allUnlockedRecords = await prisma.billingRecord.findMany({
      where: {
        userId: req.user.id,
        isUnlocked: true,
        isReference: false
      },
      orderBy: { billingMonth: 'asc' },
      select: {
        billingMonth: true,
        totalKwh: true,
        cajSemasa: true,
        teaserLow: true,
        teaserHigh: true,
        healthScore: true,
        healthBand: true,
        missionCompleted: true
      }
    });

    const potentialSavingPerMonth = bleederResult
      ? round2(bleederResult.totalPotentialSavingMyr)
      : 0;

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

    // ── UPDATE HEALTH SCORE IN DB ─────────────────────────
    if (record.healthScore !== healthResult.score) {
      await prisma.billingRecord.update({
        where: { id: record.id },
        data: {
          healthScore: healthResult.score,
          healthBand: healthResult.band,
          healthScoreThreshold: healthResult.factors.threshold.score,
          healthScoreTrend: healthResult.factors.trend.score,
          healthScoreBleeder: healthResult.factors.bleeder.score,
          healthScoreAfa: healthResult.factors.afa.score,
          healthScoreCause: healthResult.factors.cause.score,
          missionKwhTarget
        }
      });
    }

    // ── BUILD REPORT ──────────────────────────────────────
    const report = {

      health: {
        score: healthResult.score,
        band: healthResult.band,
        bandLabel: healthResult.bandLabel,
        bandEmoji: healthResult.bandEmoji,
        bandMessage: healthResult.bandMessage,
        factors: healthResult.factors,
        focusAreas: healthResult.focusAreas,
        missionKwhTarget,
        missionCompletion
      },

      billAutopsy: {
        billingMonth: record.billingMonth,
        referenceMonth: record.referenceMonth,
        billingPeriodDays: record.billingPeriodDays || 30,
        billingPeriodStart: ocrData.billingPeriodStart || null,
        billingPeriodEnd: ocrData.billingPeriodEnd || null,
        totalKwh: record.totalKwh,
        cajSemasa: currentCajSemasa,
        totalAmountMyr: ocrData.totalAmountMyr || record.totalAmountMyr,
        tunggakan: ocrData.tunggakan || record.tunggakan || 0,
        latePaymentCharge: ocrData.latePaymentCharge || record.latePaymentCharge || 0,
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
          latePaymentCharge: ocrData.latePaymentCharge || record.latePaymentCharge || 0
        },
        flags
      },

      bleeder: bleederResult ? {
        topBleeder: bleederResult.topBleeder,
        allBleeders: bleederResult.bleeders,
        totalPotentialSavingMyr: bleederResult.totalPotentialSavingMyr,
        coveragePercent: bleederResult.coveragePercent,
        coverageGapKwh: bleederResult.coverageGapKwh,
        effectiveRateSenUsed: actualEffectiveRateSen,
        institutionalWaste: institutionalWaste || null
      } : null,

      missions,

      comparison,

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

      // SIMPLIFIED SAVINGS LEDGER
      savingsLedger: {
        monthsAnalysed: allUnlockedRecords.length,
        potentialSavingPerMonth,
        healthJourney: allUnlockedRecords.map(r => ({
          billingMonth: r.billingMonth,
          healthScore: r.healthScore,
          healthBand: r.healthBand,
          missionCompleted: r.missionCompleted,
          teaserLow: r.teaserLow,
          teaserHigh: r.teaserHigh
        })),
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

// ── AFA STORY BUILDER ─────────────────────────────────────
const buildAfaStoryExplanation = (amountDiff, afaChange, behaviourChange, lang) => {
  if (amountDiff === 0) {
    return lang === 'BM'
      ? 'Bil anda sama seperti bulan lepas.'
      : 'Your bill is the same as last month.';
  }

  if (amountDiff < 0) {
    if (behaviourChange < 0 && afaChange <= 0) {
      return lang === 'BM'
        ? `Bil anda turun RM${Math.abs(amountDiff).toFixed(2)}. Tabiat anda bertambah baik DAN AFA juga membantu. Syabas!`
        : `Your bill dropped RM${Math.abs(amountDiff).toFixed(2)}. Your behaviour improved AND AFA helped too. Well done!`;
    }
    if (behaviourChange < 0) {
      return lang === 'BM'
        ? `Bil anda turun RM${Math.abs(amountDiff).toFixed(2)} kerana tabiat penggunaan anda bertambah baik. Syabas!`
        : `Your bill dropped RM${Math.abs(amountDiff).toFixed(2)} because your usage behaviour improved. Well done!`;
    }
    return lang === 'BM'
      ? `Bil anda turun RM${Math.abs(amountDiff).toFixed(2)} terutamanya kerana AFA bulan ini lebih rendah.`
      : `Your bill dropped RM${Math.abs(amountDiff).toFixed(2)} mainly because AFA is lower this month.`;
  }

  if (behaviourChange <= 0 && afaChange > 0) {
    return lang === 'BM'
      ? `Bil naik RM${amountDiff.toFixed(2)} — tetapi INI BUKAN SALAH ANDA. AFA (pelarasan bahan api kerajaan) naik RM${afaChange.toFixed(2)}. Tabiat penggunaan anda sebenarnya bertambah baik.`
      : `Bill up RM${amountDiff.toFixed(2)} — but THIS IS NOT YOUR FAULT. AFA (government fuel adjustment) increased by RM${afaChange.toFixed(2)}. Your usage behaviour actually improved.`;
  }

  if (behaviourChange > 0 && afaChange > 0) {
    const behaviourPercent = Math.round((behaviourChange / amountDiff) * 100);
    const afaPercent = 100 - behaviourPercent;
    return lang === 'BM'
      ? `Bil naik RM${amountDiff.toFixed(2)}. AFA (kerajaan) menyumbang ${afaPercent}% (RM${afaChange.toFixed(2)}) dan tabiat anda menyumbang ${behaviourPercent}% (RM${behaviourChange.toFixed(2)}).`
      : `Bill up RM${amountDiff.toFixed(2)}. AFA (government) contributed ${afaPercent}% (RM${afaChange.toFixed(2)}) and your behaviour ${behaviourPercent}% (RM${behaviourChange.toFixed(2)}).`;
  }

  return lang === 'BM'
    ? `Bil naik RM${amountDiff.toFixed(2)} kerana penggunaan anda bertambah. Semak misi JIMAT untuk mengurangkan penggunaan bulan depan.`
    : `Bill up RM${amountDiff.toFixed(2)} due to increased usage. Check your JIMAT missions to reduce next month.`;
};

// ── GET TEASER ────────────────────────────────────────────
const getTeaser = async (req, res) => {
  try {
    const { recordId } = req.params;
    const record = await prisma.billingRecord.findFirst({
      where: {
        id: recordId,
        userId: req.user.id,
        isReference: false
      },
      select: {
        id: true,
        billingMonth: true,
        referenceMonth: true,
        totalKwh: true,
        cajSemasa: true,
        totalAmountMyr: true,
        isUnlocked: true,
        teaserLow: true,
        teaserHigh: true,
        coverageGapKwh: true,
        coveragePercent: true,
        healthScore: true,
        healthBand: true,
        missionKwhTarget: true
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

    // Determine correct price based on payment history
    const previousPayments = await prisma.payment.count({
      where: { userId: req.user.id, status: 'SUCCESS' }
    });
    const effectiveStatus = previousPayments === 0 ? 'ONBOARD' : 'MONTHLY';
    const { getPricing } = require('../engine/chainEngine');
    const pricing = getPricing(req.user.userType, effectiveStatus);

    res.json({
      success: true,
      isUnlocked: false,
      teaser: {
        recordId: record.id,
        billingMonth: record.billingMonth,
        referenceMonth: record.referenceMonth,
        totalKwh: record.totalKwh,
        cajSemasa: record.cajSemasa || record.totalAmountMyr,
        totalAmountMyr: record.totalAmountMyr,
        teaserLow: record.teaserLow,
        teaserHigh: record.teaserHigh,
        coverageGapKwh: record.coverageGapKwh,
        coveragePercent: record.coveragePercent,
        healthScore: record.healthScore,
        healthBand: record.healthBand,
        missionKwhTarget: record.missionKwhTarget,
        price: pricing.price,
        total: pricing.total
      }
    });
  } catch (error) {
    console.error('Get teaser error:', error);
    res.status(500).json({ success: false, message: 'Failed to get teaser' });
  }
};

module.exports = { getReport, getTeaser };