// JIMAT TNB Math Engine
// Based on TNB Tariff Restructuring effective 1 July 2025
// Domestic Tariff — Peninsular Malaysia

const calculateTNBBill = (totalKwh, afaRateSen = 0, billingPeriodDays = 30) => {
  const kwh = parseFloat(totalKwh);

  // ── 1. GENERATION CHARGE ──────────────────────────────
  // Below 1,500 kWh = 27.03 sen/kWh
  // Above 1,500 kWh = 37.03 sen/kWh (applies to ALL kWh not just excess)
  let generationCharge = 0;
  if (kwh <= 1500) {
    generationCharge = kwh * 0.2703;
  } else {
    generationCharge = kwh * 0.3703;
  }

  // ── 2. CAPACITY CHARGE ────────────────────────────────
  // 4.55 sen/kWh flat
  const capacityCharge = kwh * 0.0455;

  // ── 3. NETWORK CHARGE ─────────────────────────────────
  // 12.85 sen/kWh flat
  const networkCharge = kwh * 0.1285;

  // ── 4. RETAIL CHARGE ──────────────────────────────────
  // RM10/month fixed — WAIVED if usage <= 600 kWh
  const retailCharge = kwh > 600 ? 10.00 : 0.00;

  // ── 5. ENERGY EFFICIENCY INCENTIVE (EEI) ─────────────
  // Tiered rebate for usage <= 1,000 kWh
  // Sliding scale — higher rebate for lower usage
  const eeRebate = calculateEEI(kwh);

  // ── 6. AFA (Automatic Fuel Adjustment) ───────────────
  // Monthly declared rate in sen/kWh
  // WAIVED if usage <= 600 kWh
  let afaCharge = 0;
  if (kwh > 600) {
    afaCharge = kwh * (afaRateSen / 100);
  }

  // ── 7. KWTBB (Renewable Energy Fund) ─────────────────
  // 1.6% of (generation + capacity + network) charges
  // WAIVED if usage <= 300 kWh
  let kwtbbCharge = 0;
  if (kwh > 300) {
    const baseForKwtbb = generationCharge + capacityCharge + networkCharge - Math.abs(eeRebate);
    kwtbbCharge = baseForKwtbb * 0.016;
  }

  // ── 8. SST (Service Tax) ──────────────────────────────
  // 8% applied on (generation + capacity + network + retail + AFA - EEI + KWTBB)
  // WAIVED if usage <= 600 kWh
  let sstCharge = 0;
  if (kwh > 600) {
    const baseForSST = generationCharge + capacityCharge + networkCharge + retailCharge + afaCharge - Math.abs(eeRebate) + kwtbbCharge;
    sstCharge = baseForSST * 0.08;
  }

  // ── TOTAL ─────────────────────────────────────────────
  const totalBill = generationCharge + capacityCharge + networkCharge + retailCharge + afaCharge - Math.abs(eeRebate) + kwtbbCharge + sstCharge;

  // ── EFFECTIVE RATE ────────────────────────────────────
  const effectiveRateSen = kwh > 0 ? (totalBill / kwh) * 100 : 0;

  return {
    kwh,
    generationCharge: round2(generationCharge),
    capacityCharge: round2(capacityCharge),
    networkCharge: round2(networkCharge),
    retailCharge: round2(retailCharge),
    eeRebate: round2(eeRebate),
    afaCharge: round2(afaCharge),
    kwtbbCharge: round2(kwtbbCharge),
    sstCharge: round2(sstCharge),
    totalBill: round2(totalBill),
    effectiveRateSen: round2(effectiveRateSen),
    // Threshold flags
    flags: {
      retailChargeWaived: kwh <= 600,
      afaWaived: kwh <= 600,
      kwtbbWaived: kwh <= 300,
      sstWaived: kwh <= 600,
      eeiApplied: kwh <= 1000,
      aboveHighTier: kwh > 1500,
      nearRetailThreshold: kwh > 540 && kwh <= 600,
      nearEeiThreshold: kwh > 900 && kwh <= 1000
    }
  };
};

// EEI Tiered Rebate Table (sen/kWh)
// Source: TNB RP4 July 2025
const calculateEEI = (kwh) => {
  if (kwh > 1000) return 0;

  // EEI bands — rebate in sen/kWh applied to entire consumption
  const eeiBands = [
    { max: 50,   sen: 25.00 },
    { max: 100,  sen: 24.50 },
    { max: 150,  sen: 24.00 },
    { max: 200,  sen: 23.50 },
    { max: 250,  sen: 23.00 },
    { max: 300,  sen: 22.50 },
    { max: 350,  sen: 22.00 },
    { max: 400,  sen: 21.00 },
    { max: 450,  sen: 19.00 },
    { max: 500,  sen: 17.00 },
    { max: 550,  sen: 14.50 },
    { max: 600,  sen: 12.00 },
    { max: 650,  sen: 9.50  },
    { max: 700,  sen: 7.00  },
    { max: 750,  sen: 4.50  },
    { max: 800,  sen: 3.00  },
    { max: 850,  sen: 2.00  },
    { max: 900,  sen: 1.50  },
    { max: 950,  sen: 1.00  },
    { max: 1000, sen: 0.50  }
  ];

  const band = eeiBands.find(b => kwh <= b.max);
  if (!band) return 0;

  // Rebate = kWh × sen/kWh rate (negative = saving)
  return -(kwh * (band.sen / 100));
};

// Compare two billing records
const compareBills = (currentBill, previousBill) => {
  const kwhDiff = currentBill.kwh - previousBill.kwh;
  const amountDiff = currentBill.totalBill - previousBill.totalBill;
  const kwhChangePercent = previousBill.kwh > 0
    ? ((kwhDiff / previousBill.kwh) * 100)
    : 0;

  return {
    kwhDiff: round2(kwhDiff),
    amountDiff: round2(amountDiff),
    kwhChangePercent: round2(kwhChangePercent),
    improved: kwhDiff < 0,
    thresholdCrossed: {
      retailCharge: previousBill.kwh <= 600 && currentBill.kwh > 600,
      eei: previousBill.kwh <= 1000 && currentBill.kwh > 1000,
      highTier: previousBill.kwh <= 1500 && currentBill.kwh > 1500
    }
  };
};

const round2 = (val) => Math.round(val * 100) / 100;

module.exports = { calculateTNBBill, compareBills, calculateEEI };