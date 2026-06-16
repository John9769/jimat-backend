const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const extractTNBBill = async (fileBuffer, mimeType = 'image/jpeg') => {
  try {
    const base64Data = fileBuffer.toString('base64');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
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
              text: `You are a TNB electricity bill OCR extractor for Malaysia. 
Extract ONLY these fields from this TNB bill image and return ONLY valid JSON, no markdown, no explanation:

{
  "billingMonth": "YYYY-MM",
  "billingPeriodDays": 30,
  "totalKwh": 0.0,
  "totalAmountMyr": 0.0,
  "generationCharge": 0.0,
  "capacityCharge": 0.0,
  "networkCharge": 0.0,
  "retailCharge": 0.0,
  "afaCharge": 0.0,
  "eeRebate": 0.0,
  "sstCharge": 0.0,
  "kwtbbCharge": 0.0,
  "accountNumber": "",
  "customerName": "",
  "premisesAddress": ""
}

Rules:
- billingMonth must be YYYY-MM format derived from bill date or billing period
- All numeric values must be numbers not strings
- If a field is not found on the bill set it to 0
- eeRebate should be positive number even though it appears as negative on bill
- Return ONLY the JSON object nothing else`
            }
          ]
        }
      ]
    });

    const rawText = response.content[0].text.trim();

    // Strip any accidental markdown
    const clean = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

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