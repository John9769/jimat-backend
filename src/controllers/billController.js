const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const { extractTNBBill } = require('../utils/ocr');
const { calculateTNBBill } = require('../engine/tnbEngine');
const { analyseBleeders, generateMissions, generateInstitutionalProfile, calculateInstitutionalWaste, calculateTeaserRange } = require('../engine/bleederEngine');
const { calculateHealthScore, calculateMissionTarget } = require('../engine/healthEngine');
const {
  getChainStatus,
  getPricing,
  validateUploadedBills,
  determineRoles,
  updateUserChainStatus
} = require('../engine/chainEngine');

const prisma = new PrismaClient();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG or PDF allowed'));
    }
  }
});

const round2 = (val) => Math.round(val * 100) / 100;

const buildAfaComponents = (ocrData) => {
  if (ocrData.afaComponents && Array.isArray(ocrData.afaComponents) && ocrData.afaComponents.length > 0) {
    return ocrData.afaComponents;
  }
  if (ocrData.afaCharge && ocrData.totalKwh && ocrData.totalKwh > 0) {
    const rateSen = (ocrData.afaCharge / ocrData.totalKwh) * 100;
    return [{ rateSen: round2(rateSen), kwh: ocrData.totalKwh, description: 'AFA', amountMyr: ocrData.afaCharge }];
  }
  return [];
};

const getOcrData = (item) => item.rawOcr || item;

// ── SAVE APPLIANCES ───────────────────────────────────────
const saveAppliances = async (req, res) => {
  try {
    const { appliances } = req.body;
    if (!appliances || !Array.isArray(appliances) || appliances.length === 0) {
      return res.status(400).json({ success: false, message: 'Appliances array required' });
    }
    await prisma.appliance.deleteMany({ where: { userId: req.user.id } });
    const created = await prisma.appliance.createMany({
      data: appliances.map(a => ({
        userId: req.user.id,
        roomName: a.roomName,
        applianceType: a.applianceType,
        brand: a.brand || null,
        hp: a.hp ? parseFloat(a.hp) : null,
        wattage: a.wattage ? parseFloat(a.wattage) : null,
        inverter: a.inverter || false,
        ageYears: parseFloat(a.ageYears) || 0,
        qty: parseInt(a.qty) || 1,
        avgHoursDaily: parseFloat(a.avgHoursDaily) || 0
      }))
    });
    res.json({ success: true, message: `${created.count} appliances saved`, count: created.count });
  } catch (error) {
    console.error('Save appliances error:', error);
    res.status(500).json({ success: false, message: 'Failed to save appliances' });
  }
};

// ── GET CHAIN INFO ────────────────────────────────────────
const getChainInfo = async (req, res) => {
  try {
    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);
    res.json({ success: true, chain: chainStatus, pricing });
  } catch (error) {
    console.error('Get chain info error:', error);
    res.status(500).json({ success: false, message: 'Failed to get chain info' });
  }
};

// ── SCAN BILLS ────────────────────────────────────────────
const scanBills = async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);

    if (chainStatus.billsRequired === 2 && files.length < 2) {
      return res.status(400).json({
        success: false,
        errorCode: 'NEED_TWO_BILLS',
        message: req.user.language === 'BM'
          ? chainStatus.status === 'RESET'
            ? 'Rantaian bil anda terputus. Sila muat naik 2 bil berturut-turut untuk tetapkan semula.'
            : 'Sila muat naik 2 bil TNB berturut-turut untuk bermula.'
          : chainStatus.status === 'RESET'
            ? 'Your bill chain is broken. Please upload 2 consecutive bills to reset.'
            : 'Please upload 2 consecutive TNB bills to get started.'
      });
    }

    const ocrResults = [];
    for (const file of files) {
      const result = await extractTNBBill(file.buffer, file.mimetype);

      if (!result.success) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal membaca bil. Muat naik sebagai PDF dari email TNB atau apl myTNB untuk ketepatan terbaik.'
            : 'Failed to read bill. Upload as PDF from TNB email or myTNB app for best accuracy.'
        });
      }

      if (!result.data.billingMonth || !/^\d{4}-\d{2}$/.test(result.data.billingMonth)) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_MONTH_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal mengesan bulan bil. Cuba muat naik sebagai PDF.'
            : 'Could not detect billing month. Try uploading as PDF.'
        });
      }

      if (!result.data.totalKwh || result.data.totalKwh <= 0) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_KWH_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal mengesan penggunaan kWh. Cuba muat naik sebagai PDF.'
            : 'Could not detect kWh usage. Try uploading as PDF.'
        });
      }

      if (!result.data.cajSemasa || result.data.cajSemasa <= 0) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_AMOUNT_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal mengesan Caj Semasa. Cuba muat naik sebagai PDF.'
            : 'Could not detect Caj Semasa. Try uploading as PDF.'
        });
      }

      ocrResults.push(result.data);
    }

    ocrResults.sort((a, b) => a.billingMonth.localeCompare(b.billingMonth));

    const uploadedMonths = ocrResults.map(r => r.billingMonth);
    const chainValidation = await validateUploadedBills(
      uploadedMonths,
      req.user.id,
      prisma,
      req.user.language || 'EN'
    );

    if (!chainValidation.valid) {
      return res.status(400).json({
        success: false,
        errorCode: chainValidation.errorCode,
        message: chainValidation.message
      });
    }

    const ocrWithRoles = determineRoles(chainValidation, ocrResults);

    const reportBill = ocrWithRoles.find(o => !o.isReference);
    const referenceBill = ocrWithRoles.find(o => o.isReference);

    res.json({
      success: true,
      requiresConfirmation: true,
      chainStatus: chainStatus.status,
      chainValidation,
      pricing,
      ocrResults: ocrWithRoles.map(ocr => ({
        billingMonth: ocr.billingMonth,
        billingPeriodStart: ocr.billingPeriodStart || null,
        billingPeriodEnd: ocr.billingPeriodEnd || null,
        billingPeriodDays: ocr.billingPeriodDays || 30,
        totalKwh: ocr.totalKwh,
        cajSemasa: ocr.cajSemasa || ocr.totalAmountMyr,
        totalAmountMyr: ocr.totalAmountMyr,
        tunggakan: ocr.tunggakan || 0,
        confidence: ocr.billingMonthConfidence || 'HIGH',
        isReference: ocr.isReference,
        referenceMonth: ocr.referenceMonth || null,
        rawOcr: ocr
      })),
      summary: {
        reportMonth: reportBill?.billingMonth || null,
        referenceMonth: referenceBill?.billingMonth || chainValidation.referenceBill || null,
        reportKwh: reportBill?.totalKwh || null,
        reportCajSemasa: reportBill?.cajSemasa || null
      }
    });

  } catch (error) {
    console.error('Scan bills error:', error);
    res.status(500).json({ success: false, message: 'Failed to scan bills' });
  }
};

// ── CONFIRM BILLS ─────────────────────────────────────────
const confirmBills = async (req, res) => {
  try {
    const { ocrResults } = req.body;

    if (!ocrResults || !Array.isArray(ocrResults) || ocrResults.length === 0) {
      return res.status(400).json({ success: false, message: 'No confirmed bill data received' });
    }

    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);

    const currentMonth = new Date().toISOString().slice(0, 7);
    const afaRecord = await prisma.afaRate.findFirst({
      where: { month: currentMonth }
    });
    const fallbackAfaRateSen = afaRecord ? afaRecord.rateSen : 0;

    const appliances = await prisma.appliance.findMany({
      where: { userId: req.user.id }
    });

    const sortedOcr = [...ocrResults].sort((a, b) => {
      const aMonth = getOcrData(a).billingMonth;
      const bMonth = getOcrData(b).billingMonth;
      return aMonth.localeCompare(bMonth);
    });

    const referenceBillItem = sortedOcr.find(o => o.isReference === true);
    const reportBillItem = sortedOcr.find(o => o.isReference === false) || sortedOcr[sortedOcr.length - 1];

    const reportRaw = getOcrData(reportBillItem);
    const referenceRaw = referenceBillItem ? getOcrData(referenceBillItem) : null;
    const latestBillingMonth = reportRaw.billingMonth;

    // ── GET REFERENCE RECORD ──────────────────────────────
    let referenceRecord = null;
    const referenceMonth = referenceRaw?.billingMonth || reportBillItem.referenceMonth;

    if (referenceMonth) {
      referenceRecord = await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: referenceMonth }
      });
    }

    const referenceOcrData = referenceRaw ||
      (referenceRecord?.rawOcrText ? JSON.parse(referenceRecord.rawOcrText) : null);

    // ── AFA COMPONENTS ────────────────────────────────────
    let afaComponents = buildAfaComponents(reportRaw);
    if (afaComponents.length === 0 && fallbackAfaRateSen !== 0) {
      afaComponents = [{
        rateSen: fallbackAfaRateSen,
        kwh: reportRaw.totalKwh,
        description: 'AFA',
        amountMyr: reportRaw.totalKwh * (fallbackAfaRateSen / 100)
      }];
    }

    // ── EFFECTIVE RATE ────────────────────────────────────
    const reportCajSemasa = reportRaw.cajSemasa || reportRaw.totalAmountMyr;
    const actualEffectiveRateSen = reportRaw.totalKwh > 0
      ? round2((reportCajSemasa / reportRaw.totalKwh) * 100)
      : 0;

    // ── ENGINE FLAGS ──────────────────────────────────────
    const billAnalysis = calculateTNBBill(
      reportRaw.totalKwh,
      afaComponents,
      reportRaw.billingPeriodDays || 30
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
        reportRaw.totalKwh,
        actualEffectiveRateSen,
        reportRaw.billingPeriodDays || 30
      );
      missions = generateMissions(bleederResult, billAnalysis, req.user.language);
    }

    if (req.user.userType === 'INSTITUTIONAL' && appliancesToUse.length > 0) {
      institutionalWaste = calculateInstitutionalWaste(
        appliancesToUse,
        reportRaw.totalKwh,
        actualEffectiveRateSen,
        reportRaw.billingPeriodDays || 30
      );
    }

    // ── HEALTH SCORE ──────────────────────────────────────
    const referenceCajSemasa = referenceOcrData?.cajSemasa || referenceOcrData?.totalAmountMyr || null;
    const referenceAfaCharge = referenceOcrData?.afaCharge || null;

    const healthResult = calculateHealthScore({
      currentKwh: reportRaw.totalKwh,
      previousKwh: referenceOcrData?.totalKwh || null,
      currentCajSemasa: reportCajSemasa,
      previousCajSemasa: referenceCajSemasa,
      currentAfaCharge: reportRaw.afaCharge || 0,
      previousAfaCharge: referenceAfaCharge,
      bleederResult,
      lang: req.user.language || 'EN'
    });

    // ── MISSION TARGET ────────────────────────────────────
    const missionKwhTarget = calculateMissionTarget(reportRaw.totalKwh);

    // ── TEASER RANGE — NEW DYNAMIC ALGO ──────────────────
    // Requires both bills + appliances + TNB tariff math
    // Falls back to bleeder total if no reference bill available
    let teaserLow = 0;
    let teaserHigh = 0;
    let teaserMessage = '';
    let teaserMessageBM = '';

    const bill1Kwh = referenceOcrData?.totalKwh || null;
    const bill1CajSemasa = referenceOcrData?.cajSemasa || referenceOcrData?.totalAmountMyr || null;

    if (bill1Kwh && bill1CajSemasa && appliancesToUse.length > 0) {
      // Full dynamic teaser — both bills + appliances
      const teaserResult = calculateTeaserRange(
        bill1Kwh,
        reportRaw.totalKwh,
        bill1CajSemasa,
        reportCajSemasa,
        appliancesToUse,
        actualEffectiveRateSen,
        reportRaw.billingPeriodDays || 30
      );
      teaserLow = teaserResult.teaserLow;
      teaserHigh = teaserResult.teaserHigh;
      teaserMessage = teaserResult.teaserMessage;
      teaserMessageBM = teaserResult.teaserMessageBM;
    } else if (bleederResult) {
      // Fallback — appliances only, no reference bill
      teaserLow = round2(bleederResult.totalPotentialSavingMyr * 0.6);
      teaserHigh = bleederResult.totalPotentialSavingMyr;
      teaserMessage = `Your report shows RM${teaserLow} – RM${teaserHigh} in potential savings from your declared appliances.`;
      teaserMessageBM = `Laporan anda menunjukkan RM${teaserLow} – RM${teaserHigh} potensi penjimatan daripada peralatan yang anda isytiharkan.`;
    }

    // Coverage gap from bleeder result
    const coverageGapKwh = bleederResult?.coverageGapKwh || 0;
    const coveragePercent = bleederResult?.coveragePercent || 0;

    // ── REPORT DATA ───────────────────────────────────────
    const reportData = {
      generatedAt: new Date().toISOString(),
      healthScore: healthResult.score,
      healthBand: healthResult.band
    };

    // ── SAVE BILLING RECORDS ──────────────────────────────
    const savedRecords = [];

    for (const item of sortedOcr) {
      const ocr = getOcrData(item);
      const billingMonth = ocr.billingMonth;
      const isRef = item.isReference === true;

      const existing = await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth }
      });

      if (!existing) {
        const ocrAfaComponents = buildAfaComponents(ocr);
        const totalAfaCharge = ocrAfaComponents.reduce((sum, c) => {
          return sum + ((c.kwh || ocr.totalKwh) * (c.rateSen / 100));
        }, 0);

        const cajSemasa = ocr.cajSemasa || ocr.totalAmountMyr;

        const record = await prisma.billingRecord.create({
          data: {
            userId: req.user.id,
            billingMonth,
            billingPeriodDays: ocr.billingPeriodDays || 30,
            billingPeriodStart: ocr.billingPeriodStart || null,
            billingPeriodEnd: ocr.billingPeriodEnd || null,
            totalKwh: ocr.totalKwh,
            totalAmountMyr: ocr.totalAmountMyr || cajSemasa,
            cajSemasa,
            tunggakan: ocr.tunggakan || 0,
            generationCharge: ocr.generationCharge || 0,
            capacityCharge: ocr.capacityCharge || 0,
            networkCharge: ocr.networkCharge || 0,
            retailCharge: ocr.retailCharge || 0,
            afaCharge: round2(totalAfaCharge) || ocr.afaCharge || 0,
            eeRebate: ocr.eeRebate || 0,
            sstCharge: ocr.sstCharge || 0,
            kwtbbCharge: ocr.kwtbbCharge || 0,
            latePaymentCharge: ocr.latePaymentCharge || 0,
            rawOcrText: JSON.stringify(ocr),

            isReference: isRef,
            referenceMonth: isRef ? null : (referenceRaw?.billingMonth || item.referenceMonth || null),
            isUnlocked: false,

            // TEASER RANGE — only on report bill
            teaserLow: isRef ? null : teaserLow,
            teaserHigh: isRef ? null : teaserHigh,

            // COVERAGE GAP — only on report bill
            coverageGapKwh: isRef ? null : coverageGapKwh,
            coveragePercent: isRef ? null : coveragePercent,

            // HEALTH SCORE — only on report bill
            healthScore: isRef ? null : healthResult.score,
            healthBand: isRef ? null : healthResult.band,
            healthScoreThreshold: isRef ? null : healthResult.factors.threshold.score,
            healthScoreTrend: isRef ? null : healthResult.factors.trend.score,
            healthScoreBleeder: isRef ? null : healthResult.factors.bleeder.score,
            healthScoreAfa: isRef ? null : healthResult.factors.afa.score,
            healthScoreCause: isRef ? null : healthResult.factors.cause.score,

            // INSTITUTIONAL
            expectedKwhMonthly: isRef ? null : (institutionalWaste?.expectedKwhMonthly || null),
            wastedKwhMonthly: isRef ? null : (institutionalWaste?.wastedKwhMonthly || null),
            wastedAmountMyr: isRef ? null : (institutionalWaste?.wastedAmountMyr || null),

            missionKwhTarget: isRef ? null : missionKwhTarget,
            reportData: isRef ? null : reportData
          }
        });
        savedRecords.push(record);
      }
    }

    // ── MISSION COMPLETION CHECK ──────────────────────────
    if (chainStatus.status === 'MONTHLY' && referenceRecord && referenceRecord.missionKwhTarget) {
      const missionCompleted = reportRaw.totalKwh <= referenceRecord.missionKwhTarget;
      await prisma.billingRecord.update({
        where: { id: referenceRecord.id },
        data: {
          missionKwhActual: reportRaw.totalKwh,
          missionCompleted
        }
      });
    }

    // ── UPDATE CHAIN STATUS ───────────────────────────────
    await updateUserChainStatus(
      req.user.id,
      'MONTHLY',
      latestBillingMonth,
      prisma
    );

    const latestRecord = savedRecords.find(r => r.billingMonth === latestBillingMonth)
      || await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: latestBillingMonth }
      });

    res.json({
      success: true,
      teaser: {
        billingMonth: latestBillingMonth,
        referenceMonth: referenceRaw?.billingMonth || null,
        totalKwh: reportRaw.totalKwh,
        totalAmountMyr: reportCajSemasa,
        teaserLow,
        teaserHigh,
        teaserMessage: req.user.language === 'BM' ? teaserMessageBM : teaserMessage,
        coverageGapKwh,
        coveragePercent,
        topBleederType: bleederResult?.topBleeder?.applianceType || null,
        recordId: latestRecord?.id || null,
        healthScore: healthResult.score,
        healthBand: healthResult.band,
        healthBandEmoji: healthResult.bandEmoji,
        missionKwhTarget
      },
      pricing,
      isUnlocked: false
    });

  } catch (error) {
    console.error('Confirm bills error:', error);
    res.status(500).json({ success: false, message: 'Failed to confirm bills' });
  }
};

const uploadBills = scanBills;

// ── GET BILLING HISTORY ───────────────────────────────────
const getBillingHistory = async (req, res) => {
  try {
    const records = await prisma.billingRecord.findMany({
      where: {
        userId: req.user.id,
        isReference: false
      },
      orderBy: { billingMonth: 'desc' },
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
        missionCompleted: true,
        createdAt: true
      }
    });
    res.json({ success: true, records });
  } catch (error) {
    console.error('Get billing history error:', error);
    res.status(500).json({ success: false, message: 'Failed to get history' });
  }
};

module.exports = {
  upload,
  saveAppliances,
  getChainInfo,
  scanBills,
  confirmBills,
  uploadBills,
  getBillingHistory
};