const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const extractTNBBill = async (fileBuffer, mimeType = 'image/jpeg') => {
  try {
    const base64Data = fileBuffer.toString('base64');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: `You are an expert TNB (Tenaga Nasional Berhad) electricity bill OCR extractor for Malaysia.

Study this TNB bill carefully and extract ALL fields. Return ONLY valid JSON, no markdown, no explanation.

IMPORTANT — TNB bills have these specific components:
1. Tenaga (Generation) — RM0.2703/kWh label
2. AFA — Can appear as MULTIPLE lines with different rates and dates e.g. "AFA (-RM0.0047/kWh : 01.04.26)" and "AFA (-RM0.0259/kWh : 01.06.26)"
3. Kapasiti (Capacity) — RM0.0455/kWh
4. Rangkaian (Network) — RM0.1285/kWh
5. Peruncitan (Retail) — fixed RM10.00
6. INS. CEKAP TENAGA — energy efficiency rebate (negative value, appears as -RM0.075/kWh)
7. Caj Semasa — current month charge subtotal
8. Service Tax (8%) — SST
9. KWTBB (1.6%) — renewable energy fund
10. Surcaj Lewat Bayar — late payment surcharge (if any)

Return this exact JSON structure:

{
  "billingMonth": "YYYY-MM",
  "billingPeriodDays": 30,
  "billingPeriodStart": "DD.MM.YYYY",
  "billingPeriodEnd": "DD.MM.YYYY",
  "totalKwh": 0.0,
  "totalAmountMyr": 0.0,
  "accountNumber": "",
  "customerName": "",
  "premisesAddress": "",
  "generationCharge": 0.0,
  "capacityCharge": 0.0,
  "networkCharge": 0.0,
  "retailCharge": 0.0,
  "eeRebate": 0.0,
  "sstCharge": 0.0,
  "kwtbbCharge": 0.0,
  "latePaymentCharge": 0.0,
  "cajSemasa": 0.0,
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
  "previousPayment": 0.0,
  "tariff": "Domestik Am"
}

CRITICAL RULES:
1. billingMonth = YYYY-MM from the billing period END date
2. totalKwh = total kWh usage shown on bill (Penggunaan Anda)
3. totalAmountMyr = Jumlah Perlu Dibayar (total amount due) — this is the GRAND TOTAL including arrears
4. cajSemasa = Caj Semasa only (current month charges, not including arrears)
5. generationCharge = Tenaga total column value (positive number)
6. capacityCharge = Kapasiti total column value (positive number)  
7. networkCharge = Rangkaian total column value (positive number)
8. retailCharge = Peruncitan total column value (positive, 0 if waived)
9. eeRebate = INS. CEKAP TENAGA total value as POSITIVE number (even though it is negative on bill)
10. sstCharge = Service Tax (8%) value (positive number)
11. kwtbbCharge = KWTBB (1.6%) value (positive number)
12. latePaymentCharge = Surcaj Lewat Bayar value (0 if none)
13. afaCharge = SUM of ALL AFA lines total column values (can be negative if rebate, positive if surcharge)
14. afaComponents = Extract EACH AFA line separately:
    - rateSen = rate in sen/kWh (negative if rebate e.g. -0.47 for -RM0.0047/kWh, positive if surcharge e.g. 1.38 for RM0.0138/kWh)
    - description = full AFA description from bill e.g. "AFA (-RM0.0047/kWh : 01.04.26)"
    - amountMyr = total amount for this AFA line from total column
    - kwh = kWh this AFA applies to (usually same as totalKwh)
15. All numeric values must be numbers not strings
16. If field not found set to 0 or empty string
17. Return ONLY the JSON object nothing else`
            }
          ]
        }
      ]
    });

    const rawText = response.content[0].text.trim();
    const clean = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Post-process — ensure afaComponents is always array
    if (!parsed.afaComponents || !Array.isArray(parsed.afaComponents)) {
      parsed.afaComponents = [];
    }

    // If afaCharge extracted but no components — create single component
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

    // Use cajSemasa as totalAmountMyr for engine calculation
    // totalAmountMyr from bill includes arrears — we want current month only
    if (parsed.cajSemasa && parsed.cajSemasa > 0) {
      parsed.currentMonthAmountMyr = parsed.cajSemasa;
    } else {
      parsed.currentMonthAmountMyr = parsed.totalAmountMyr;
    }

    console.log('OCR extracted:', {
      billingMonth: parsed.billingMonth,
      totalKwh: parsed.totalKwh,
      cajSemasa: parsed.cajSemasa,
      totalAmountMyr: parsed.totalAmountMyr,
      afaComponents: parsed.afaComponents,
      eeRebate: parsed.eeRebate
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