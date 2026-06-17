const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const { extractTNBBill } = require('../utils/ocr');
const { calculateTNBBill, compareBills } = require('../engine/tnbEngine');
const { analyseBleeders, generateMissions } = require('../engine/bleederEngine');
const { getChainStatus, getPricing, validateUploadedBills } = require('../engine/chainEngine');

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

// ── NEW ENDPOINT 1 — SCAN ONLY ────────────────────────────
// OCR fires, validates, returns extracted values
// NO database save — user must confirm first
const scanBills = async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    // Get chain status
    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);

    // Check file count
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

    // OCR all uploaded files
    const ocrResults = [];
    for (const file of files) {
      const result = await extractTNBBill(file.buffer, file.mimetype);

      if (!result.success) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal membaca bil. Untuk ketepatan terbaik, muat naik bil dalam format PDF dari email TNB atau apl myTNB anda.'
            : 'Failed to read bill. For best accuracy, upload your bill as PDF from your TNB email or myTNB app.'
        });
      }

      // Validate billing month extracted
      if (!result.data.billingMonth || result.data.billingMonth === 'YYYY-MM' || !/^\d{4}-\d{2}$/.test(result.data.billingMonth)) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_MONTH_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal mengesan bulan bil. Cuba muat naik sebagai PDF dari email TNB atau apl myTNB untuk ketepatan lebih baik.'
            : 'Could not detect billing month. Try uploading as PDF from your TNB email or myTNB app for better accuracy.'
        });
      }

      // Validate kWh extracted
      if (!result.data.totalKwh || result.data.totalKwh <= 0) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_KWH_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal mengesan penggunaan kWh. Cuba muat naik sebagai PDF dari email TNB atau apl myTNB.'
            : 'Could not detect kWh usage. Try uploading as PDF from your TNB email or myTNB app.'
        });
      }

      // Validate cajSemasa extracted
      if (!result.data.cajSemasa || result.data.cajSemasa <= 0) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_AMOUNT_FAILED',
          isPdfAdvice: true,
          message: req.user.language === 'BM'
            ? 'Gagal mengesan jumlah bil semasa. Cuba muat naik sebagai PDF dari email TNB atau apl myTNB.'
            : 'Could not detect current bill amount. Try uploading as PDF from your TNB email or myTNB app.'
        });
      }

      ocrResults.push(result.data);
    }

    // Sort by billingMonth ascending
    ocrResults.sort((a, b) => a.billingMonth.localeCompare(b.billingMonth));

    // Chain validation — check months against DB
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

    // Return OCR extracted values for user confirmation
    // DO NOT save to DB yet
    const latestOcr = ocrResults[ocrResults.length - 1];

    console.log('Scan complete — awaiting user confirmation:', {
      billingMonth: latestOcr.billingMonth,
      totalKwh: latestOcr.totalKwh,
      cajSemasa: latestOcr.cajSemasa,
      confidence: latestOcr.billingMonthConfidence
    });

    res.json({
      success: true,
      requiresConfirmation: true,
      chainStatus: chainStatus.status,
      pricing,
      // All OCR results for confirmation — user verifies these
      ocrResults: ocrResults.map(ocr => ({
        billingMonth: ocr.billingMonth,
        billingPeriodStart: ocr.billingPeriodStart || null,
        billingPeriodEnd: ocr.billingPeriodEnd || null,
        billingPeriodDays: ocr.billingPeriodDays || 30,
        totalKwh: ocr.totalKwh,
        cajSemasa: ocr.cajSemasa || ocr.totalAmountMyr,
        totalAmountMyr: ocr.totalAmountMyr,
        tunggakan: ocr.tunggakan || 0,
        confidence: ocr.billingMonthConfidence || 'HIGH',
        // Full raw OCR for confirm endpoint
        rawOcr: ocr
      }))
    });

  } catch (error) {
    console.error('Scan bills error:', error);
    res.status(500).json({ success: false, message: 'Failed to scan bills' });
  }
};

// ── NEW ENDPOINT 2 — CONFIRM & SAVE ──────────────────────
// User confirmed OCR values are correct
// NOW we save to DB, run engine, return teaser
const confirmBills = async (req, res) => {
  try {
    // ocrResults = array of confirmed OCR data from FE
    // User has verified these values match their physical bill
    const { ocrResults } = req.body;

    if (!ocrResults || !Array.isArray(ocrResults) || ocrResults.length === 0) {
      return res.status(400).json({ success: false, message: 'No confirmed bill data received' });
    }

    // Get chain status + pricing
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

    // Sort by billingMonth ascending
    const sortedOcr = [...ocrResults].sort((a, b) =>
      (a.rawOcr?.billingMonth || a.billingMonth).localeCompare(b.rawOcr?.billingMonth || b.billingMonth)
    );

    const latestOcr = sortedOcr[sortedOcr.length - 1];
    const latestRaw = latestOcr.rawOcr || latestOcr;

    // Build AFA components
    let afaComponents = buildAfaComponents(latestRaw);
    if (afaComponents.length === 0 && fallbackAfaRateSen !== 0) {
      afaComponents = [{
        rateSen: fallbackAfaRateSen,
        kwh: latestRaw.totalKwh,
        description: 'AFA',
        amountMyr: latestRaw.totalKwh * (fallbackAfaRateSen / 100)
      }];
    }

    // Run TNB engine — for effective rate only (used by bleeder)
    const billAnalysis = calculateTNBBill(
      latestRaw.totalKwh,
      afaComponents,
      latestRaw.billingPeriodDays || 30
    );

    // Run bleeder engine
    let bleederResult = null;
    let missions = [];
    if (appliances.length > 0) {
      bleederResult = analyseBleeders(
        appliances,
        latestRaw.totalKwh,
        billAnalysis.effectiveRateSen,
        latestRaw.billingPeriodDays || 30
      );
      missions = generateMissions(bleederResult, billAnalysis, req.user.language);
    }

    // Get previous bill for comparison
    const latestBillingMonth = latestRaw.billingMonth;
    const previousRecord = await prisma.billingRecord.findFirst({
      where: {
        userId: req.user.id,
        billingMonth: { lt: latestBillingMonth }
      },
      orderBy: { billingMonth: 'desc' }
    });

    let comparison = null;
    if (previousRecord) {
      let prevAfaComponents = [];
      try {
        if (previousRecord.rawOcrText) {
          const prevOcr = JSON.parse(previousRecord.rawOcrText);
          prevAfaComponents = buildAfaComponents(prevOcr);
        }
      } catch (e) {}
      if (prevAfaComponents.length === 0 && previousRecord.afaCharge && previousRecord.totalKwh > 0) {
        prevAfaComponents = [{ rateSen: (previousRecord.afaCharge / previousRecord.totalKwh) * 100, kwh: previousRecord.totalKwh }];
      }
      const prevAnalysis = calculateTNBBill(
        previousRecord.totalKwh,
        prevAfaComponents,
        previousRecord.billingPeriodDays || 30
      );
      comparison = compareBills(billAnalysis, prevAnalysis);
    }

    // Calculate teaser
    const teaserAmount = bleederResult
      ? bleederResult.totalPotentialSavingMyr
      : round2((latestRaw.cajSemasa || latestRaw.totalAmountMyr) * 0.15);

    // Build report data
    const reportData = {
      billAutopsy: billAnalysis,
      bleeders: bleederResult,
      missions,
      comparison,
      afaComponents,
      generatedAt: new Date().toISOString()
    };

    // Save billing records to DB
    const savedRecords = [];
    for (const item of sortedOcr) {
      const ocr = item.rawOcr || item;
      const billingMonth = ocr.billingMonth;

      const existing = await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth }
      });

      if (!existing) {
        const ocrAfaComponents = buildAfaComponents(ocr);
        const totalAfaCharge = ocrAfaComponents.reduce((sum, c) => {
          return sum + ((c.kwh || ocr.totalKwh) * (c.rateSen / 100));
        }, 0);

        const record = await prisma.billingRecord.create({
          data: {
            userId: req.user.id,
            billingMonth,
            billingPeriodDays: ocr.billingPeriodDays || 30,
            totalKwh: ocr.totalKwh,
            totalAmountMyr: ocr.cajSemasa || ocr.totalAmountMyr,
            generationCharge: ocr.generationCharge || 0,
            capacityCharge: ocr.capacityCharge || 0,
            networkCharge: ocr.networkCharge || 0,
            retailCharge: ocr.retailCharge || 0,
            afaCharge: round2(totalAfaCharge) || ocr.afaCharge || 0,
            eeRebate: ocr.eeRebate || 0,
            sstCharge: ocr.sstCharge || 0,
            kwtbbCharge: ocr.kwtbbCharge || 0,
            rawOcrText: JSON.stringify(ocr),
            isUnlocked: false,
            reportData: billingMonth === latestBillingMonth ? reportData : {},
            teaserAmount: billingMonth === latestBillingMonth ? teaserAmount : null
          }
        });
        savedRecords.push(record);
      }
    }

    const latestRecord = savedRecords.find(r => r.billingMonth === latestBillingMonth)
      || await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: latestBillingMonth }
      });

    console.log('Bills confirmed and saved:', {
      userId: req.user.id,
      billingMonth: latestBillingMonth,
      recordId: latestRecord?.id,
      teaserAmount
    });

    res.json({
      success: true,
      teaser: {
        billingMonth: latestBillingMonth,
        totalKwh: latestRaw.totalKwh,
        totalAmountMyr: latestRaw.cajSemasa || latestRaw.totalAmountMyr,
        estimatedOverspendMyr: teaserAmount,
        topBleederType: bleederResult?.topBleeder?.applianceType || null,
        recordId: latestRecord?.id || null
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

const getBillingHistory = async (req, res) => {
  try {
    const records = await prisma.billingRecord.findMany({
      where: { userId: req.user.id },
      orderBy: { billingMonth: 'desc' },
      select: {
        id: true,
        billingMonth: true,
        totalKwh: true,
        totalAmountMyr: true,
        isUnlocked: true,
        teaserAmount: true,
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
  uploadBills, // backward compat
  getBillingHistory
};