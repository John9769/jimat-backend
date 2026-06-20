const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const extractTNBBill = async (fileBuffer, mimeType = 'image/jpeg') => {
  try {
    const base64Data = fileBuffer.toString('base64');

    const isPdf = mimeType === 'application/pdf';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: isPdf ? 'document' : 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: `You are an expert TNB (Tenaga Nasional Berhad) electricity bill OCR extractor for Malaysia.

Study every part of this TNB bill image very carefully before extracting data.

MOST CRITICAL — BILLING MONTH EXTRACTION:
The billingMonth is the MOST important field. Get this wrong and the entire system fails.

Step 1: Find "Tempoh Bil" (Billing Period) on the bill
- Format: DD.MM.YYYY - DD.MM.YYYY
- Example: "12.05.2026 - 11.06.2026"
- Take the END date = 11.06.2026
- billingMonth = "2026-06"

Step 2: Find "Tarikh Bil" (Bill Date)
- Example: "11 Jun 2026"
- Cross-check: month should match END date of Tempoh Bil
- If Tarikh Bil = June 2026 and Tempoh Bil ends June 2026 → HIGH confidence

Step 3: Calculate billingPeriodDays
- Count days between start and end of Tempoh Bil
- Example: 12.05.2026 to 11.06.2026 = 30 days

NEVER use the START date of Tempoh Bil as the billing month.
ALWAYS use the END date of Tempoh Bil as the billing month.

TNB BILL COMPONENTS TO EXTRACT:
1. Tenaga — RM0.2703/kWh (generation charge)
2. AFA — can be MULTIPLE lines, extract each separately
   - Negative AFA = rebate (e.g. "AFA (-RM0.0047/kWh : 01.04.26)")
   - Positive AFA = surcharge (e.g. "AFA (RM0.0259/kWh : 01.06.26)")
3. Kapasiti — RM0.0455/kWh (capacity charge)
4. Rangkaian — RM0.1285/kWh (network charge)
5. Peruncitan — RM10.00 fixed (retail charge, 0 if below 600 kWh)
6. INS. CEKAP TENAGA — energy efficiency rebate (-RM0.075/kWh × 600 kWh)
7. Caj Semasa — current month subtotal
8. Service Tax (8%) — SST
9. KWTBB (1.6%) — renewable energy fund
10. Surcaj Lewat Bayar — late payment (if any)
11. Jumlah Perlu Dibayar — GRAND TOTAL (may include arrears)
12. Tunggakan — arrears from previous months (if any)

Return ONLY this JSON, nothing else:

{
  "billingMonth": "YYYY-MM",
  "billingMonthConfidence": "HIGH",
  "billingPeriodStart": "YYYY-MM-DD",
  "billingPeriodEnd": "YYYY-MM-DD",
  "billingPeriodDays": 30,
  "billDate": "YYYY-MM-DD",
  "totalKwh": 0.0,
  "totalAmountMyr": 0.0,
  "cajSemasa": 0.0,
  "tunggakan": 0.0,
  "accountNumber": "",
  "customerName": "",
  "premisesAddress": "",
  "tariff": "Domestik Am",
  "generationCharge": 0.0,
  "capacityCharge": 0.0,
  "networkCharge": 0.0,
  "retailCharge": 0.0,
  "eeRebate": 0.0,
  "sstCharge": 0.0,
  "kwtbbCharge": 0.0,
  "latePaymentCharge": 0.0,
  "afaCharge": 0.0,
  "afaComponents": [
    {
      "rateSen": 0.0,
      "description": "",
      "amountMyr": 0.0,
      "kwh": 0.0
    }
  ],
  "previousBalance": 0.0,
  "previousPayment": 0.0
}

EXTRACTION RULES:
1. billingMonth = YYYY-MM from END date of Tempoh Bil — CRITICAL
2. billingMonthConfidence = HIGH if Tempoh Bil and Tarikh Bil match same month, LOW if uncertain
3. billingPeriodStart = start date of Tempoh Bil in YYYY-MM-DD format
4. billingPeriodEnd = end date of Tempoh Bil in YYYY-MM-DD format
5. billingPeriodDays = number of days in billing period
6. billDate = Tarikh Bil in YYYY-MM-DD format
7. totalKwh = Penggunaan Anda kWh (look for kWh column, NOT kW or kVARh)
8. totalAmountMyr = Jumlah Perlu Dibayar (GRAND TOTAL including arrears)
9. cajSemasa = Caj Semasa value (current month only, NOT including arrears)
10. tunggakan = Tunggakan value (arrears, 0 if none)
11. generationCharge = Tenaga TOTAL column (positive)
12. capacityCharge = Kapasiti TOTAL column (positive)
13. networkCharge = Rangkaian TOTAL column (positive)
14. retailCharge = Peruncitan TOTAL column (positive, 0 if waived)
15. eeRebate = INS. CEKAP TENAGA TOTAL as POSITIVE number
16. sstCharge = Service Tax (8%) value (positive)
17. kwtbbCharge = KWTBB (1.6%) value (positive)
18. latePaymentCharge = Surcaj Lewat Bayar (0 if none)
19. afaCharge = NET sum of ALL AFA amounts (positive if surcharge, negative if net rebate)
20. afaComponents = Extract EACH AFA line separately:
    - rateSen: convert rate to sen/kWh (e.g. RM0.0047/kWh = 0.47 sen, negative if rebate = -0.47)
    - description: exact text from bill
    - amountMyr: total column amount for this AFA line
    - kwh: kWh this applies to (usually same as totalKwh)
21. All numbers must be numbers not strings
22. If field not found set to 0 or empty string
23. Return ONLY the JSON object — absolutely nothing else`
            }
          ]
        }
      ]
    });

    const rawText = response.content[0].text.trim();
    const clean = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // ── POST PROCESSING ───────────────────────────────────

    // Ensure afaComponents is always array
    if (!parsed.afaComponents || !Array.isArray(parsed.afaComponents)) {
      parsed.afaComponents = [];
    }

    // Remove zero-rate AFA components
    parsed.afaComponents = parsed.afaComponents.filter(c => c.rateSen !== 0);

    // If afaCharge exists but no components — reconstruct
    if (parsed.afaComponents.length === 0 && parsed.afaCharge !== 0 && parsed.totalKwh > 0) {
      const rateSen = (parsed.afaCharge / parsed.totalKwh) * 100;
      parsed.afaComponents = [{
        rateSen: Math.round(rateSen * 100) / 100,
        description: 'AFA',
        amountMyr: parsed.afaCharge,
        kwh: parsed.totalKwh
      }];
    }

    // Ensure eeRebate is positive
    if (parsed.eeRebate < 0) {
      parsed.eeRebate = Math.abs(parsed.eeRebate);
    }

    // currentMonthAmountMyr — use cajSemasa for engine (excludes arrears)
    parsed.currentMonthAmountMyr = parsed.cajSemasa > 0
      ? parsed.cajSemasa
      : parsed.totalAmountMyr;

    // Validate billingMonth format
    if (!parsed.billingMonth || !/^\d{4}-\d{2}$/.test(parsed.billingMonth)) {
      // Try to derive from billingPeriodEnd
      if (parsed.billingPeriodEnd) {
        const parts = parsed.billingPeriodEnd.split('-');
        if (parts.length === 3) {
          parsed.billingMonth = `${parts[0]}-${parts[1]}`;
          parsed.billingMonthConfidence = 'MEDIUM';
        }
      }
    }

    console.log('OCR extracted:', {
      billingMonth: parsed.billingMonth,
      confidence: parsed.billingMonthConfidence,
      billingPeriodStart: parsed.billingPeriodStart,
      billingPeriodEnd: parsed.billingPeriodEnd,
      totalKwh: parsed.totalKwh,
      cajSemasa: parsed.cajSemasa,
      totalAmountMyr: parsed.totalAmountMyr,
      tunggakan: parsed.tunggakan,
      eeRebate: parsed.eeRebate,
      afaComponents: parsed.afaComponents
    });

    return {
      success: true,
      data: parsed,
      rawText
    };

  } catch (error) {
    console.error('OCR extraction error:', error);
    return {
      success: false,
      error: error.message,
      data: null
    };
  }
};

module.exports = { extractTNBBill };