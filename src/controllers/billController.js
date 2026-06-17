const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const { extractTNBBill } = require('../utils/ocr');
const { calculateTNBBill } = require('../engine/tnbEngine');
const { analyseBleeders, generateMissions } = require('../engine/bleederEngine');
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
// OCR only — NO DB save — returns values for user confirmation
const scanBills = async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);

    // File count check
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

    // OCR all files
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

    // Sort ascending
    ocrResults.sort((a, b) => a.billingMonth.localeCompare(b.billingMonth));

    // Chain validation
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

    // Determine roles — which bill is reference, which is report
    const ocrWithRoles = determineRoles(chainValidation, ocrResults);

    console.log('Scan complete — awaiting confirmation:', {
      roles: ocrWithRoles.map(o => ({
        month: o.billingMonth,
        isReference: o.isReference,
        kWh: o.totalKwh,
        cajSemasa: o.cajSemasa
      }))
    });

    // Return for user confirmation
    // Show ONLY the report bill details for confirmation
    // Reference bill shown minimally
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
      // Summary for confirm screen
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
// User confirmed OCR values
// Save to DB with 2-bill 1-report logic
// Calculate health score + mission target
// Update User.chainStatus
const confirmBills = async (req, res) => {
  try {
    const { ocrResults } = req.body;

    if (!ocrResults || !Array.isArray(ocrResults) || ocrResults.length === 0) {
      return res.status(400).json({ success: false, message: 'No confirmed bill data received' });
    }

    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);

    // Get admin AFA rate as fallback
    const currentMonth = new Date().toISOString().slice(0, 7);
    const afaRecord = await prisma.afaRate.findFirst({
      where: { month: currentMonth }
    });
    const fallbackAfaRateSen = afaRecord ? afaRecord.rateSen : 0;

    // Get user appliances
    const appliances = await prisma.appliance.findMany({
      where: { userId: req.user.id }
    });

    // Sort ascending
    const sortedOcr = [...ocrResults].sort((a, b) => {
      const aMonth = getOcrData(a).billingMonth;
      const bMonth = getOcrData(b).billingMonth;
      return aMonth.localeCompare(bMonth);
    });

    // Identify reference vs report bills
    // isReference comes from scanBills determination
    const referenceBillItem = sortedOcr.find(o => o.isReference === true);
    const reportBillItem = sortedOcr.find(o => o.isReference === false) || sortedOcr[sortedOcr.length - 1];

    const reportRaw = getOcrData(reportBillItem);
    const referenceRaw = referenceBillItem ? getOcrData(referenceBillItem) : null;
    const latestBillingMonth = reportRaw.billingMonth;

    console.log('Confirm bills:', {
      reportMonth: latestBillingMonth,
      referenceMonth: referenceRaw?.billingMonth || reportBillItem.referenceMonth,
      isReference: referenceBillItem ? true : false
    });

    // ── GET REFERENCE RECORD ──────────────────────────────
    // For MONTHLY users — reference is in DB
    // For ONBOARD/RESET — reference is the first uploaded bill
    let referenceRecord = null;
    const referenceMonth = referenceRaw?.billingMonth || reportBillItem.referenceMonth;

    if (referenceMonth) {
      referenceRecord = await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: referenceMonth }
      });
    }

    // Get reference OCR data for comparison
    const referenceOcrData = referenceRaw ||
      (referenceRecord?.rawOcrText ? JSON.parse(referenceRecord.rawOcrText) : null);

    // ── BUILD AFA COMPONENTS ──────────────────────────────
    let afaComponents = buildAfaComponents(reportRaw);
    if (afaComponents.length === 0 && fallbackAfaRateSen !== 0) {
      afaComponents = [{
        rateSen: fallbackAfaRateSen,
        kwh: reportRaw.totalKwh,
        description: 'AFA',
        amountMyr: reportRaw.totalKwh * (fallbackAfaRateSen / 100)
      }];
    }

    // ── EFFECTIVE RATE — FROM ACTUAL BILL ─────────────────
    const reportCajSemasa = reportRaw.cajSemasa || reportRaw.totalAmountMyr;
    const actualEffectiveRateSen = reportRaw.totalKwh > 0
      ? round2((reportCajSemasa / reportRaw.totalKwh) * 100)
      : 0;

    // ── ENGINE — for flags only ───────────────────────────
    const billAnalysis = calculateTNBBill(
      reportRaw.totalKwh,
      afaComponents,
      reportRaw.billingPeriodDays || 30
    );

    // ── BLEEDER ENGINE ────────────────────────────────────
    let bleederResult = null;
    let missions = [];
    if (appliances.length > 0) {
      bleederResult = analyseBleeders(
        appliances,
        reportRaw.totalKwh,
        actualEffectiveRateSen,
        reportRaw.billingPeriodDays || 30
      );
      missions = generateMissions(bleederResult, billAnalysis, req.user.language);
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

    console.log('Health score calculated:', {
      score: healthResult.score,
      band: healthResult.band,
      factors: Object.entries(healthResult.factors).map(([k, v]) => `${k}:${v.score}`)
    });

    // ── MISSION KWH TARGET ────────────────────────────────
    const missionKwhTarget = calculateMissionTarget(reportRaw.totalKwh);

    // ── TEASER AMOUNT ─────────────────────────────────────
    const teaserAmount = bleederResult
      ? bleederResult.totalPotentialSavingMyr
      : round2(reportCajSemasa * 0.15);

    // ── REPORT DATA ───────────────────────────────────────
    const reportData = {
      generatedAt: new Date().toISOString(),
      healthScore: healthResult.score,
      healthBand: healthResult.band
    };

    // ── SAVE BILLING RECORDS ──────────────────────────────
    // 2-BILL 1-REPORT LOGIC:
    // Reference bill → isReference: true, no teaserAmount, no payment needed
    // Report bill → isReference: false, has teaserAmount, payment required
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
            cajSemasa: cajSemasa,
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

            // ── 2-BILL 1-REPORT ──────────────────────────
            isReference: isRef,
            referenceMonth: isRef ? null : (referenceRaw?.billingMonth || item.referenceMonth || null),

            // Reference bill = locked forever (no payment, no unlock)
            // Report bill = locked until payment
            isUnlocked: false,

            // Only report bill has teaser + health score
            teaserAmount: isRef ? null : teaserAmount,
            healthScore: isRef ? null : healthResult.score,
            healthBand: isRef ? null : healthResult.band,
            healthScoreThreshold: isRef ? null : healthResult.factors.threshold.score,
            healthScoreTrend: isRef ? null : healthResult.factors.trend.score,
            healthScoreBleeder: isRef ? null : healthResult.factors.bleeder.score,
            healthScoreAfa: isRef ? null : healthResult.factors.afa.score,
            healthScoreCause: isRef ? null : healthResult.factors.cause.score,

            // Mission target for next month
            missionKwhTarget: isRef ? null : missionKwhTarget,
            missionsData: isRef ? null : (missions.length > 0 ? missions : null),

            reportData: isRef ? null : reportData
          }
        });
        savedRecords.push(record);
      }
    }

    // ── UPDATE PREVIOUS RECORD MISSION COMPLETION ─────────
    // If this is a loyal upload — check if previous mission was completed
    if (chainStatus.status === 'MONTHLY' && referenceRecord && referenceRecord.missionKwhTarget) {
      const missionCompleted = reportRaw.totalKwh <= referenceRecord.missionKwhTarget;
      await prisma.billingRecord.update({
        where: { id: referenceRecord.id },
        data: {
          missionKwhActual: reportRaw.totalKwh,
          missionCompleted
        }
      });
      console.log('Mission completion updated:', {
        referenceMonth: referenceRecord.billingMonth,
        target: referenceRecord.missionKwhTarget,
        actual: reportRaw.totalKwh,
        completed: missionCompleted
      });
    }

    // ── UPDATE USER CHAIN STATUS ──────────────────────────
    await updateUserChainStatus(
      req.user.id,
      'MONTHLY', // After successful save — user is now loyal
      latestBillingMonth,
      prisma
    );

    // ── GET LATEST RECORD ─────────────────────────────────
    const latestRecord = savedRecords.find(r => r.billingMonth === latestBillingMonth)
      || await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: latestBillingMonth }
      });

    console.log('Bills confirmed and saved successfully:', {
      userId: req.user.id,
      reportMonth: latestBillingMonth,
      referenceMonth: referenceRaw?.billingMonth,
      recordId: latestRecord?.id,
      healthScore: healthResult.score,
      teaserAmount,
      missionTarget: missionKwhTarget
    });

    res.json({
      success: true,
      teaser: {
        billingMonth: latestBillingMonth,
        referenceMonth: referenceRaw?.billingMonth || null,
        totalKwh: reportRaw.totalKwh,
        totalAmountMyr: reportCajSemasa,
        estimatedOverspendMyr: teaserAmount,
        topBleederType: bleederResult?.topBleeder?.applianceType || null,
        recordId: latestRecord?.id || null,
        // Health score preview in teaser
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

// Keep uploadBills as alias for backward compatibility
const uploadBills = scanBills;

// ── GET BILLING HISTORY ───────────────────────────────────
// Only return non-reference records
// Reference bills are hidden from users
const getBillingHistory = async (req, res) => {
  try {
    const records = await prisma.billingRecord.findMany({
      where: {
        userId: req.user.id,
        isReference: false  // ← Hide reference bills from history
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
        teaserAmount: true,
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