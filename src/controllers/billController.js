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

// Build AFA components from OCR data
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

const uploadBills = async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    // Get chain status first
    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);

    // Check file count matches requirement
    if (chainStatus.billsRequired === 2 && files.length < 2) {
      return res.status(400).json({
        success: false,
        errorCode: 'NEED_TWO_BILLS',
        message: chainStatus.status === 'RESET'
          ? (req.user.language === 'BM'
            ? `Rantaian bil anda terputus. Sila muat naik 2 bil berturut-turut untuk tetapkan semula.`
            : `Your bill chain is broken. Please upload 2 consecutive bills to reset.`)
          : (req.user.language === 'BM'
            ? `Sila muat naik 2 bil TNB berturut-turut untuk bermula.`
            : `Please upload 2 consecutive TNB bills to get started.`)
      });
    }

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

    // Step 1 — OCR all uploaded bills
    const ocrResults = [];
    for (const file of files) {
      const result = await extractTNBBill(file.buffer, file.mimetype);
      if (!result.success) {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_FAILED',
          message: req.user.language === 'BM'
            ? `Gagal membaca bil. Sila pastikan gambar bil jelas dan cuba lagi.`
            : `Failed to read bill. Please ensure the bill image is clear and try again.`
        });
      }

      // Validate billingMonth extracted properly
      if (!result.data.billingMonth || result.data.billingMonth === 'YYYY-MM') {
        return res.status(400).json({
          success: false,
          errorCode: 'OCR_MONTH_FAILED',
          message: req.user.language === 'BM'
            ? `Gagal mengesan bulan bil. Sila pastikan gambar bil jelas menunjukkan Tempoh Bil.`
            : `Failed to detect bill month. Please ensure the billing period is clearly visible.`
        });
      }

      ocrResults.push(result.data);
    }

    // Sort by billingMonth ascending
    ocrResults.sort((a, b) => a.billingMonth.localeCompare(b.billingMonth));

    // Step 2 — CRITICAL chain validation
    // Validates month correctness, duplicates, old bills, wrong bills
    const uploadedMonths = ocrResults.map(r => r.billingMonth);
    const chainValidation = await validateUploadedBills(
      uploadedMonths,
      req.user.id,
      prisma,
      req.user.language || 'EN'
    );

    if (!chainValidation.valid) {
      console.log('Chain validation failed:', chainValidation.errorCode, chainValidation.message);
      return res.status(400).json({
        success: false,
        errorCode: chainValidation.errorCode,
        message: chainValidation.message
      });
    }

    // Use the LATEST bill for analysis
    const latestOcr = ocrResults[ocrResults.length - 1];

    // Step 3 — Build AFA components from OCR
    let afaComponents = buildAfaComponents(latestOcr);
    if (afaComponents.length === 0 && fallbackAfaRateSen !== 0) {
      afaComponents = [{ rateSen: fallbackAfaRateSen, kwh: latestOcr.totalKwh, description: 'AFA', amountMyr: latestOcr.totalKwh * (fallbackAfaRateSen / 100) }];
    }

    // Step 4 — Run TNB math engine
    const billAnalysis = calculateTNBBill(
      latestOcr.totalKwh,
      afaComponents,
      latestOcr.billingPeriodDays || 30
    );

    // Step 5 — Run bleeder engine
    let bleederResult = null;
    let missions = [];
    if (appliances.length > 0) {
      bleederResult = analyseBleeders(
        appliances,
        latestOcr.totalKwh,
        billAnalysis.effectiveRateSen,
        latestOcr.billingPeriodDays || 30
      );
      missions = generateMissions(bleederResult, billAnalysis, req.user.language);
    }

    // Step 6 — Get previous bill for comparison
    const previousRecord = await prisma.billingRecord.findFirst({
      where: {
        userId: req.user.id,
        billingMonth: { lt: latestOcr.billingMonth }
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

    // Step 7 — Calculate teaser amount
    const teaserAmount = bleederResult
      ? bleederResult.totalPotentialSavingMyr
      : round2(latestOcr.totalAmountMyr * 0.15);

    // Step 8 — Build report data
    const reportData = {
      billAutopsy: billAnalysis,
      bleeders: bleederResult,
      missions,
      comparison,
      afaComponents,
      generatedAt: new Date().toISOString()
    };

    // Step 9 — Save billing records
    const savedRecords = [];
    for (const ocr of ocrResults) {
      const existing = await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: ocr.billingMonth }
      });

      if (!existing) {
        const ocrAfaComponents = buildAfaComponents(ocr);
        const totalAfaCharge = ocrAfaComponents.reduce((sum, c) => {
          return sum + ((c.kwh || ocr.totalKwh) * (c.rateSen / 100));
        }, 0);

        const record = await prisma.billingRecord.create({
          data: {
            userId: req.user.id,
            billingMonth: ocr.billingMonth,
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
            reportData: ocr.billingMonth === latestOcr.billingMonth ? reportData : {},
            teaserAmount: ocr.billingMonth === latestOcr.billingMonth ? teaserAmount : null
          }
        });
        savedRecords.push(record);
      }
    }

    const latestRecord = savedRecords.find(r => r.billingMonth === latestOcr.billingMonth)
      || await prisma.billingRecord.findFirst({
        where: { userId: req.user.id, billingMonth: latestOcr.billingMonth }
      });

    res.json({
      success: true,
      teaser: {
        billingMonth: latestOcr.billingMonth,
        totalKwh: latestOcr.totalKwh,
        totalAmountMyr: latestOcr.cajSemasa || latestOcr.totalAmountMyr,
        estimatedOverspendMyr: teaserAmount,
        topBleederType: bleederResult?.topBleeder?.applianceType || null,
        recordId: latestRecord?.id || null
      },
      pricing,
      isUnlocked: false
    });

  } catch (error) {
    console.error('Upload bills error:', error);
    res.status(500).json({ success: false, message: 'Failed to process bills' });
  }
};

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

module.exports = { upload, saveAppliances, getChainInfo, uploadBills, getBillingHistory };