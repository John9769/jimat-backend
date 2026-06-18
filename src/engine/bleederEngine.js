// JIMAT Bleeder Engine v4
// Teaser algo: dynamic math from both bills + declared appliances
// Temperature optimisation + timer saving — not generic hour reduction
// Mission 1 = coverage gap if < 80%, else top bleeder
// Sources: TNB HEC, ASHRAE, Malaysian consumer electronics ratings

const AIRCOND_RATED_WATT = {
  0.5:  373,
  0.75: 560,
  1.0:  746,
  1.5:  1119,
  2.0:  1492,
  2.5:  1865,
  3.0:  2238,
  4.0:  2984
};

const getAircondWattage = (hp, inverter) => {
  const hpKey = parseFloat(hp);
  const keys = Object.keys(AIRCOND_RATED_WATT).map(Number);
  const closest = keys.reduce((prev, curr) =>
    Math.abs(curr - hpKey) < Math.abs(prev - hpKey) ? curr : prev
  );
  const rated = AIRCOND_RATED_WATT[closest] || (hpKey * 746);
  return inverter ? Math.round(rated * 0.65) : Math.round(rated * 1.15);
};

const APPLIANCE_WATTAGE = {
  REFRIGERATOR:    { wattage: 55   },
  WASHING_MACHINE: { wattage: 500  },
  TV:              { wattage: 60   },
  WATER_HEATER:    { wattage: 3500 },
  RICE_COOKER:     { wattage: 600  },
  MICROWAVE:       { wattage: 1000 },
  LIGHTS:          { wattage: 10   },
  WATER_PUMP:      { wattage: 375  },
  COMPUTER:        { wattage: 200  },
  FAN:             { wattage: 50   },
  IRON:            { wattage: 1000 },
  OTHER:           { wattage: 100  }
};

const CENTRAL_AIRCOND_RT = {
  SMALL:      { midpointRT: 15  },
  MEDIUM:     { midpointRT: 35  },
  LARGE:      { midpointRT: 75  },
  VERY_LARGE: { midpointRT: 150 }
};

const getCentralAircondWattage = (sizeCategory) => {
  const rt = CENTRAL_AIRCOND_RT[sizeCategory]?.midpointRT || 35;
  return Math.round(rt * 0.879 * 1000);
};

const PRAYER_HOURS = {
  AIRCOND:      6.77,
  LIGHTS:       4.5,
  WATER_HEATER: 2.5
};

const getAgePenalty = (ageYears) => {
  const penalty = Math.min(ageYears * 0.02, 0.20);
  return 1 + penalty;
};

const round2 = (val) => Math.round(val * 100) / 100;

// ── TIER DROP SAVING ──────────────────────────────────────
// Exact TNB tariff math — not estimated
// Below 600 kWh: no retail charge (RM10), no SST (8%), reduced AFA exposure
// Generation rate above 600 = RM0.3703 vs RM0.2703 below
const calculateTierDropSaving = (currentKwh, effectiveRateSen) => {
  if (currentKwh <= 600) return 0;

  const excessKwh = currentKwh - 600;

  // Generation charge saving — excess units at higher rate
  const generationSaving = excessKwh * (0.3703 - 0.2703); // RM0.10/kWh diff

  // Retail charge saving — RM10 fixed waived below 600
  const retailSaving = 10.00;

  // SST saving — 8% on excess charges
  const sstSaving = (generationSaving + retailSaving) * 0.08;

  return round2(generationSaving + retailSaving + sstSaving);
};

// ── AIRCOND TEMPERATURE + TIMER SAVING ───────────────────
// Temperature: every 1°C increase from 24°C saves ~6% energy
// 24°C → 26°C = 12% saving on that unit
// Timer: dead time = hours running in empty/sleeping room
// Non-inverter dead time est. 1.5hrs/day (runs full load even when room cold)
// Inverter dead time est. 0.5hrs/day (modulates but still runs)
const calculateAircondSaving = (appliance, adjustedWattage, billingPeriodDays, effectiveRateSen) => {
  const monthlyKwh = (adjustedWattage * appliance.avgHoursDaily * billingPeriodDays * (appliance.qty || 1)) / 1000;
  const monthlyCost = monthlyKwh * (effectiveRateSen / 100);

  let immediateSavingMyr = 0;
  let immediateTip = '';
  let longtermSavingMyr = 0;
  let longtermTip = '';

  if (!appliance.inverter) {
    // Non-inverter
    // Temperature: 24°C → 26°C = 12% saving
    const tempSavingKwh = monthlyKwh * 0.12;
    const tempSavingMyr = round2(tempSavingKwh * (effectiveRateSen / 100));

    // Timer: 1.5hrs dead time/day running on cold/empty room
    const timerKwh = (adjustedWattage * 1.5 * billingPeriodDays * (appliance.qty || 1)) / 1000;
    const timerSavingMyr = round2(timerKwh * (effectiveRateSen / 100));

    immediateSavingMyr = round2(tempSavingMyr + timerSavingMyr);
    immediateTip = `Set to 26°C (saves 12%) + use sleep timer — your ${appliance.roomName} aircond is costing RM${round2(monthlyCost)}/month. Combined saving: est. RM${immediateSavingMyr}/month`;

    // Long term — inverter upgrade saves ~43%
    longtermSavingMyr = round2(monthlyCost * 0.43);
    longtermTip = `Upgrade to inverter unit — save est. RM${longtermSavingMyr}/month permanently. Payback typically 2-3 years.`;

  } else {
    // Inverter
    // Temperature: 24°C → 26°C = 12% saving
    const tempSavingKwh = monthlyKwh * 0.12;
    immediateSavingMyr = round2(tempSavingKwh * (effectiveRateSen / 100));
    immediateTip = `Set to 26°C — your ${appliance.roomName} inverter aircond costs RM${round2(monthlyCost)}/month. Temperature saving: est. RM${immediateSavingMyr}/month`;

    // Timer: 0.5hrs dead time
    const timerKwh = (adjustedWattage * 0.5 * billingPeriodDays * (appliance.qty || 1)) / 1000;
    longtermSavingMyr = round2(timerKwh * (effectiveRateSen / 100));
    longtermTip = `Add sleep timer — cut 30 mins of idle running. Save est. RM${longtermSavingMyr}/month`;
  }

  return { immediateSavingMyr, immediateTip, longtermSavingMyr, longtermTip, monthlyCost };
};

// ── TEASER RANGE CALCULATOR ───────────────────────────────
// Dynamic math — both bills + declared appliances + TNB tariff
// Signal 1: Trend (only if Bill2 > Bill1)
// Signal 2: Tier drop (only if Bill2 > 600 kWh)
// Signal 3: Appliance optimisation (temperature + timer + age)
// teaserLow = highest single signal
// teaserHigh = all signals combined
// teaserMessage = framing based on trend direction
const calculateTeaserRange = (bill1Kwh, bill2Kwh, bill1CajSemasa, bill2CajSemasa, appliances, effectiveRateSen, billingPeriodDays = 30) => {

  // Signal 1 — Trend projection (3 months)
  let signal1 = 0;
  let trendDirection = 'flat';

  if (bill2Kwh > bill1Kwh) {
    trendDirection = 'up';
    const monthlyDrift = bill2CajSemasa - bill1CajSemasa;
    signal1 = round2(monthlyDrift * 3); // 3 month projection
  } else if (bill2Kwh < bill1Kwh) {
    trendDirection = 'down';
    signal1 = 0; // No trend signal for improving users
  }

  // Signal 2 — Tier drop
  const signal2 = calculateTierDropSaving(bill2Kwh, effectiveRateSen);

  // Signal 3 — Appliance optimisation
  let signal3 = 0;
  let topApplianceSaving = 0;

  appliances.forEach(appliance => {
    let wattage = 0;

    if (appliance.applianceType === 'AIRCOND') {
      wattage = getAircondWattage(appliance.hp || 1.5, appliance.inverter || false);
    } else if (appliance.applianceType === 'CENTRAL_AIRCOND') {
      wattage = appliance.wattage || getCentralAircondWattage('MEDIUM');
    } else if (appliance.wattage && appliance.wattage > 0) {
      wattage = parseFloat(appliance.wattage);
    } else {
      wattage = APPLIANCE_WATTAGE[appliance.applianceType]?.wattage || 100;
    }

    const agePenalty = getAgePenalty(appliance.ageYears || 0);
    const adjustedWattage = wattage * agePenalty;

    let savingMyr = 0;

    if (appliance.applianceType === 'AIRCOND' || appliance.applianceType === 'CENTRAL_AIRCOND') {
      const result = calculateAircondSaving(appliance, adjustedWattage, billingPeriodDays, effectiveRateSen);
      savingMyr = result.immediateSavingMyr;
    } else if (appliance.applianceType === 'REFRIGERATOR' && appliance.ageYears >= 8) {
      // Old fridge — clean coils 15% gain + upgrade saving
      const monthlyKwh = (adjustedWattage * 24 * billingPeriodDays) / 1000;
      savingMyr = round2(monthlyKwh * (effectiveRateSen / 100) * 0.15);
    } else if (appliance.applianceType === 'WATER_HEATER') {
      const monthlyKwh = (adjustedWattage * appliance.avgHoursDaily * billingPeriodDays) / 1000;
      savingMyr = round2(monthlyKwh * (effectiveRateSen / 100) * 0.30);
    } else {
      const monthlyKwh = (adjustedWattage * appliance.avgHoursDaily * billingPeriodDays * (appliance.qty || 1)) / 1000;
      savingMyr = round2(monthlyKwh * (effectiveRateSen / 100) * 0.08);
    }

    signal3 = round2(signal3 + savingMyr);
    if (savingMyr > topApplianceSaving) topApplianceSaving = savingMyr;
  });

  // teaserLow = highest single signal (most conservative)
  const teaserLow = round2(Math.max(signal2, topApplianceSaving));

  // teaserHigh = all signals combined (full potential)
  // For trending down users — no signal1
  const teaserHigh = round2(
    trendDirection === 'up'
      ? signal2 + signal3 + (signal1 * 0.3) // partial trend — conservative
      : signal2 + signal3
  );

  // Teaser message framing
  let teaserMessage = '';
  let teaserMessageBM = '';

  if (trendDirection === 'up') {
    teaserMessage = `Your bill grew RM${round2(bill2CajSemasa - bill1CajSemasa)} last month. At this rate, you could save RM${teaserLow} – RM${teaserHigh} next month.`;
    teaserMessageBM = `Bil anda naik RM${round2(bill2CajSemasa - bill1CajSemasa)} bulan lepas. Anda boleh jimat RM${teaserLow} – RM${teaserHigh} bulan depan.`;
  } else if (trendDirection === 'down') {
    teaserMessage = `Good progress — bill dropped RM${round2(bill1CajSemasa - bill2CajSemasa)}. But RM${teaserLow} – RM${teaserHigh} is still bleeding. Your report shows exactly where.`;
    teaserMessageBM = `Bagus — bil turun RM${round2(bill1CajSemasa - bill2CajSemasa)}. Tapi RM${teaserLow} – RM${teaserHigh} masih membazir. Laporan anda tunjukkan di mana.`;
  } else {
    teaserMessage = `Your bill hasn't moved — but RM${teaserLow} – RM${teaserHigh} in savings is still hiding. AFA can change that without warning.`;
    teaserMessageBM = `Bil anda tidak berubah — tapi RM${teaserLow} – RM${teaserHigh} penjimatan masih tersembunyi. AFA boleh ubah itu tanpa amaran.`;
  }

  return {
    teaserLow: Math.max(teaserLow, 0),
    teaserHigh: Math.max(teaserHigh, teaserLow),
    trendDirection,
    signals: {
      trend: round2(signal1),
      tierDrop: signal2,
      applianceOptimisation: signal3
    },
    teaserMessage,
    teaserMessageBM
  };
};

// ── ANALYSE BLEEDERS ──────────────────────────────────────
const analyseBleeders = (appliances, totalKwh, effectiveRateSen, billingPeriodDays = 30) => {
  const results = [];
  let totalEstimatedKwh = 0;

  appliances.forEach(appliance => {
    let wattage = 0;

    if (appliance.applianceType === 'AIRCOND') {
      wattage = getAircondWattage(appliance.hp || 1.5, appliance.inverter || false);
    } else if (appliance.applianceType === 'CENTRAL_AIRCOND') {
      wattage = appliance.wattage || getCentralAircondWattage('MEDIUM');
    } else if (appliance.wattage && appliance.wattage > 0) {
      wattage = parseFloat(appliance.wattage);
    } else {
      wattage = APPLIANCE_WATTAGE[appliance.applianceType]?.wattage || 100;
    }

    const agePenalty = getAgePenalty(appliance.ageYears || 0);
    const adjustedWattage = wattage * agePenalty;
    const monthlyKwh = (adjustedWattage * appliance.avgHoursDaily * billingPeriodDays * (appliance.qty || 1)) / 1000;
    const monthlyCostMyr = monthlyKwh * (effectiveRateSen / 100);

    let immediateSavingMyr = 0;
    let immediateTip = '';
    let longtermSavingMyr = 0;
    let longtermTip = '';

    if (appliance.applianceType === 'AIRCOND') {
      const result = calculateAircondSaving(appliance, adjustedWattage, billingPeriodDays, effectiveRateSen);
      immediateSavingMyr = result.immediateSavingMyr;
      immediateTip = result.immediateTip;
      longtermSavingMyr = result.longtermSavingMyr;
      longtermTip = result.longtermTip;

    } else if (appliance.applianceType === 'CENTRAL_AIRCOND') {
      const wastedHours = appliance.avgHoursDaily - PRAYER_HOURS.AIRCOND;
      if (wastedHours > 0) {
        const wastedKwh = (adjustedWattage * wastedHours * billingPeriodDays) / 1000;
        immediateSavingMyr = round2(wastedKwh * (effectiveRateSen / 100));
        immediateTip = `Central aircond running ${appliance.avgHoursDaily.toFixed(1)}hrs/day — prayer schedule needs only ${PRAYER_HOURS.AIRCOND}hrs. Switch off between prayers — save est. RM${immediateSavingMyr}/month`;
      } else {
        immediateSavingMyr = round2(monthlyCostMyr * 0.10);
        immediateTip = `Set thermostat to 24°C — each 1°C lower increases consumption 10%. Save est. RM${immediateSavingMyr}/month`;
      }
      longtermSavingMyr = round2(monthlyCostMyr * 0.15);
      longtermTip = `Install BMS timer — auto-on 30 mins before prayer, auto-off 15 mins after. ROI typically 12-18 months.`;

    } else if (appliance.applianceType === 'REFRIGERATOR') {
      if (appliance.ageYears >= 8) {
        immediateSavingMyr = round2(monthlyCostMyr * 0.15);
        immediateTip = `Fridge is ${Math.floor(appliance.ageYears)} years old — clean condenser coils now. Dirty coils force compressor to overwork. Save est. RM${immediateSavingMyr}/month immediately`;
        longtermSavingMyr = round2(monthlyCostMyr * 0.40);
        longtermTip = `Replace with 4-5 star inverter model — compressor technology saves up to 40% vs ${Math.floor(appliance.ageYears)}-year-old unit`;
      } else {
        immediateSavingMyr = round2(monthlyCostMyr * 0.10);
        immediateTip = `Check door seal and set temperature to 4°C — save est. RM${immediateSavingMyr}/month`;
        longtermSavingMyr = round2(monthlyCostMyr * 0.10);
        longtermTip = `Keep coils clean — 15% efficiency gain from annual cleaning`;
      }

    } else if (appliance.applianceType === 'WATER_HEATER') {
      immediateSavingMyr = round2(monthlyCostMyr * 0.30);
      immediateTip = `Switch off water heater at the mains when not in use — it draws 3,500W on standby. Save est. RM${immediateSavingMyr}/month immediately`;
      longtermSavingMyr = round2(monthlyCostMyr * 0.15);
      longtermTip = `Install timer switch — auto-on 30 mins before shower time only`;

    } else if (appliance.applianceType === 'WASHING_MACHINE') {
      immediateSavingMyr = round2(monthlyCostMyr * 0.20);
      immediateTip = `Run only full loads — half-load uses same energy as full load. Save est. RM${immediateSavingMyr}/month`;
      longtermSavingMyr = round2(monthlyCostMyr * 0.15);
      longtermTip = `Cold water wash saves energy — heat accounts for 90% of washing machine power`;

    } else if (appliance.applianceType === 'TV') {
      immediateSavingMyr = round2(monthlyCostMyr * 0.15);
      immediateTip = `Switch off completely at the plug — TV on standby draws 5-10W continuously. Save est. RM${immediateSavingMyr}/month`;
      longtermSavingMyr = round2(monthlyCostMyr * 0.10);
      longtermTip = `Reduce screen brightness by 30% — significant saving over ${appliance.avgHoursDaily}hrs/day usage`;

    } else if (appliance.applianceType === 'LIGHTS') {
      immediateSavingMyr = round2(monthlyCostMyr * 0.20);
      immediateTip = `Switch off lights in unoccupied rooms — save est. RM${immediateSavingMyr}/month immediately`;
      if (appliance.ageYears >= 3) {
        longtermSavingMyr = round2(monthlyCostMyr * 0.50);
        longtermTip = `Replace with latest LED — uses 50% less than older fluorescent tubes`;
      } else {
        longtermSavingMyr = round2(monthlyCostMyr * 0.10);
        longtermTip = `Install motion sensors for common areas — lights off automatically`;
      }

    } else if (appliance.ageYears >= 7) {
      immediateSavingMyr = round2(monthlyCostMyr * 0.08);
      immediateTip = `Service this unit — ${Math.floor(appliance.ageYears)}-year-old appliance running inefficiently. Save est. RM${immediateSavingMyr}/month`;
      longtermSavingMyr = round2(monthlyCostMyr * 0.25);
      longtermTip = `Replace with energy-efficient model — save est. RM${longtermSavingMyr}/month long term`;

    } else {
      immediateSavingMyr = round2(monthlyCostMyr * 0.08);
      immediateTip = `Switch off standby mode — phantom load adds up over ${appliance.avgHoursDaily}hrs/day`;
      longtermSavingMyr = round2(monthlyCostMyr * 0.10);
      longtermTip = `Use smart plug to monitor and cut idle consumption`;
    }

    totalEstimatedKwh += monthlyKwh;

    results.push({
      applianceId: appliance.id,
      roomName: appliance.roomName,
      applianceType: appliance.applianceType,
      brand: appliance.brand || '',
      hp: appliance.hp || null,
      qty: appliance.qty || 1,
      inverter: appliance.inverter || false,
      ageYears: appliance.ageYears || 0,
      avgHoursDaily: appliance.avgHoursDaily,
      wattageUsed: Math.round(adjustedWattage),
      estimatedKwh: round2(monthlyKwh),
      estimatedCostMyr: round2(monthlyCostMyr),
      potentialSavingMyr: immediateSavingMyr,
      immediateTip,
      immediateSavingMyr,
      longtermTip,
      longtermSavingMyr,
      shareOfBill: 0
    });
  });

  results.sort((a, b) => b.estimatedCostMyr - a.estimatedCostMyr);

  const totalEstimatedCost = results.reduce((sum, r) => sum + r.estimatedCostMyr, 0);
  results.forEach(r => {
    r.shareOfBill = totalEstimatedCost > 0
      ? Math.round((r.estimatedCostMyr / totalEstimatedCost) * 100)
      : 0;
  });

  const totalPotentialSaving = results.reduce((sum, r) => sum + r.immediateSavingMyr, 0);
  const coveragePercent = totalKwh > 0
    ? Math.round((totalEstimatedKwh / totalKwh) * 100)
    : 0;
  const coverageGapKwh = round2(Math.max(totalKwh - totalEstimatedKwh, 0));

  return {
    bleeders: results,
    topBleeder: results[0] || null,
    totalEstimatedKwh: round2(totalEstimatedKwh),
    totalPotentialSavingMyr: round2(totalPotentialSaving),
    coveragePercent,
    coverageGapKwh
  };
};

// ── GENERATE MISSIONS ─────────────────────────────────────
// Every declared appliance gets a mission
// Total of all missions = totalPotentialSavingMyr exactly
// Tier drop added as bonus mission if above 600 kWh
const generateMissions = (bleederResult, billAnalysis, language = 'EN') => {
  if (!bleederResult) return { missions: [], totalSaving: 0, coverageNote: null };

  const { bleeders, coveragePercent, coverageGapKwh } = bleederResult;
  const { flags } = billAnalysis;

  const missions = [];

  // Every appliance = one mission with exact saving
  bleeders.forEach((bleeder, i) => {
    if (bleeder.immediateSavingMyr > 0) {
      missions.push({
        priority: i + 1,
        icon: i === 0 ? '⚡' : '💡',
        title: i === 0
          ? (language === 'BM' ? 'Buat Malam Ini — Percuma' : 'Do This Tonight — Free')
          : (language === 'BM' ? `Kurangkan Kos: ${bleeder.roomName}` : `Cut Cost: ${bleeder.roomName}`),
        description: bleeder.immediateTip,
        estimatedSavingMyr: bleeder.immediateSavingMyr,
        appliance: `${bleeder.roomName} — ${bleeder.applianceType}`,
        isCoverageAlert: false
      });
    }
  });

  // Tier drop — bonus mission if above 600 kWh
  if (flags && flags.aboveThreshold) {
    const tierDropSaving = calculateTierDropSaving(
      billAnalysis.kwh || 0,
      billAnalysis.effectiveRateSen || 39
    );
    if (tierDropSaving > 0) {
      missions.push({
        priority: missions.length + 1,
        icon: '🎯',
        title: language === 'BM' ? 'Sasaran: Bawah 600 kWh' : 'Target: Below 600 kWh',
        description: language === 'BM'
          ? `Anda ${Math.round((billAnalysis.kwh || 0) - 600)} kWh melebihi had 600 kWh. Turun bawah 600 kWh — Caj Runcit RM10 + SST dikecualikan automatik. Jimat est. RM${tierDropSaving}/bulan.`
          : `You are ${Math.round((billAnalysis.kwh || 0) - 600)} kWh above 600 threshold. Drop below 600 kWh — RM10 Retail Charge + SST waived automatically. Save est. RM${tierDropSaving}/month.`,
        estimatedSavingMyr: tierDropSaving,
        appliance: null,
        isCoverageAlert: false
      });
    }
  }

  // Total = exact sum of ALL missions shown
  const totalSaving = round2(missions.reduce((sum, m) => sum + (m.estimatedSavingMyr || 0), 0));

  // Coverage gap — note only
  const coverageNote = coveragePercent < 80 && coverageGapKwh > 0
    ? (language === 'BM'
      ? `Peralatan yang anda isytiharkan menyumbang ${coveragePercent}% penggunaan sebenar. Tambah peralatan yang tiada bulan depan untuk analisis lebih tepat.`
      : `Your declared appliances account for ${coveragePercent}% of actual usage. Add missing appliances next month for a more accurate analysis.`)
    : null;

  return { missions, totalSaving, coverageNote };
};
const generateMissions = (bleederResult, billAnalysis, language = 'EN') => {
  if (!bleederResult) return { missions: [], totalSaving: 0, coverageNote: null };

  const missions = [];
  const { bleeders, topBleeder, coveragePercent, coverageGapKwh, totalPotentialSavingMyr } = bleederResult;
  const { flags } = billAnalysis;

  // Mission 1 — Top bleeder IMMEDIATE action always
  // Coverage gap moved to note only — not a mission
  if (topBleeder && topBleeder.immediateSavingMyr > 0) {
    missions.push({
      priority: 1,
      icon: '⚡',
      title: language === 'BM' ? 'Buat Malam Ini — Percuma' : 'Do This Tonight — Free',
      description: topBleeder.immediateTip,
      estimatedSavingMyr: topBleeder.immediateSavingMyr,
      appliance: `${topBleeder.roomName} — ${topBleeder.applianceType}`,
      isCoverageAlert: false
    });
  }

  // Mission 2 — Tier drop if above 600 kWh
  if (flags && flags.aboveThreshold) {
    const tierDropSaving = calculateTierDropSaving(
      billAnalysis.kwh || 0,
      billAnalysis.effectiveRateSen || 39
    );
    if (tierDropSaving > 0) {
      missions.push({
        priority: 2,
        icon: '🎯',
        title: language === 'BM' ? 'Sasaran: Bawah 600 kWh' : 'Target: Below 600 kWh',
        description: language === 'BM'
          ? `Anda ${Math.round((billAnalysis.kwh || 0) - 600)} kWh melebihi had 600 kWh. Turun bawah 600 kWh — Caj Runcit RM10 + SST dikecualikan automatik. Jimat est. RM${tierDropSaving}/bulan.`
          : `You are ${Math.round((billAnalysis.kwh || 0) - 600)} kWh above 600 threshold. Drop below 600 kWh — RM10 Retail Charge + SST waived automatically. Save est. RM${tierDropSaving}/month.`,
        estimatedSavingMyr: tierDropSaving,
        appliance: null,
        isCoverageAlert: false
      });
    }
  }

  // Mission 3 — Second bleeder immediate action
  if (bleeders.length > 1 && bleeders[1].immediateSavingMyr > 0) {
    const second = bleeders[1];
    missions.push({
      priority: 3,
      icon: '💡',
      title: language === 'BM' ? 'Kurangkan Pembazir #2' : 'Cut Your #2 Cost',
      description: second.immediateTip,
      estimatedSavingMyr: second.immediateSavingMyr,
      appliance: `${second.roomName} — ${second.applianceType}`,
      isCoverageAlert: false
    });
  }

  // Coverage gap — note only, not a mission
  const coverageNote = coveragePercent < 80 && coverageGapKwh > 0
    ? (language === 'BM'
      ? `Peralatan yang anda isytiharkan menyumbang ${coveragePercent}% penggunaan sebenar. Tambah peralatan yang tiada bulan depan untuk analisis lebih tepat.`
      : `Your declared appliances account for ${coveragePercent}% of actual usage. Add missing appliances next month for a more accurate analysis.`)
    : null;

  return {
    missions: missions.slice(0, 3),
    totalSaving: round2(totalPotentialSavingMyr || 0),
    coverageNote
  };
};

// ── INSTITUTIONAL PROFILE GENERATOR ──────────────────────
const generateInstitutionalProfile = (user) => {
  const appliances = [];
  const buildingAgeMap = { 1: 2, 2: 10, 3: 18 };
  const ageYears = buildingAgeMap[user.buildingAge] || 10;

  if (user.aircondSystemType === 'CENTRAL') {
    const wattage = getCentralAircondWattage(user.centralAircondSize || 'MEDIUM');
    appliances.push({
      roomName: 'Dewan Solat',
      applianceType: 'CENTRAL_AIRCOND',
      wattage,
      ageYears,
      qty: 1,
      avgHoursDaily: PRAYER_HOURS.AIRCOND,
      inverter: false,
      hp: null,
      brand: null
    });
  }

  const floorAreaM2Map = { 1: 18.6, 2: 32.5, 3: 69.7, 4: 139.4 };
  const lightWperM2Map = { 1: 10, 2: 20, 3: 15 };
  const floorM2 = floorAreaM2Map[user.floorAreaCategory] || 32.5;
  const wPerM2 = lightWperM2Map[user.lightType] || 15;
  const lightingWattage = Math.round(floorM2 * wPerM2);

  appliances.push({
    roomName: 'Dewan Solat',
    applianceType: 'LIGHTS',
    wattage: lightingWattage,
    ageYears,
    qty: 1,
    avgHoursDaily: PRAYER_HOURS.LIGHTS,
    inverter: false,
    hp: null,
    brand: null
  });

  appliances.push({
    roomName: 'Kawasan Wudhu',
    applianceType: 'WATER_HEATER',
    wattage: 3500,
    ageYears,
    qty: 1,
    avgHoursDaily: PRAYER_HOURS.WATER_HEATER,
    inverter: false,
    hp: null,
    brand: null
  });

  appliances.push({
    roomName: 'Sistem Air',
    applianceType: 'WATER_PUMP',
    wattage: 375,
    ageYears,
    qty: 1,
    avgHoursDaily: 3,
    inverter: false,
    hp: null,
    brand: null
  });

  return appliances;
};

// ── INSTITUTIONAL WASTE ───────────────────────────────────
const calculateInstitutionalWaste = (appliances, actualKwh, effectiveRateSen, billingPeriodDays = 30) => {
  let expectedKwh = 0;

  appliances.forEach(appliance => {
    let wattage = 0;
    if (appliance.applianceType === 'CENTRAL_AIRCOND') {
      wattage = appliance.wattage || 0;
    } else if (appliance.applianceType === 'AIRCOND') {
      wattage = getAircondWattage(appliance.hp || 1.5, appliance.inverter || false);
    } else {
      wattage = appliance.wattage || APPLIANCE_WATTAGE[appliance.applianceType]?.wattage || 0;
    }
    const agePenalty = getAgePenalty(appliance.ageYears || 0);
    const adjusted = wattage * agePenalty;
    expectedKwh += (adjusted * appliance.avgHoursDaily * billingPeriodDays * (appliance.qty || 1)) / 1000;
  });

  const wastedKwh = Math.max(actualKwh - expectedKwh, 0);
  const wastedAmountMyr = round2(wastedKwh * (effectiveRateSen / 100));

  return {
    expectedKwhMonthly: round2(expectedKwh),
    wastedKwhMonthly: round2(wastedKwh),
    wastedAmountMyr,
    wastePercent: actualKwh > 0 ? Math.round((wastedKwh / actualKwh) * 100) : 0
  };
};

module.exports = {
  analyseBleeders,
  generateMissions,
  generateInstitutionalProfile,
  calculateInstitutionalWaste,
  calculateTeaserRange,
  calculateTierDropSaving,
  PRAYER_HOURS
};