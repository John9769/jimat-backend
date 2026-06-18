// JIMAT Bleeder Engine v3
// ALL wattage figures from verified Malaysian sources:
// - Aircond: TNB HEC official HP→Watt table (hec.tnb.com.my)
// - Non-inverter runs at ~115% rated (compressor always full load)
// - Inverter runs at ~65% rated (modulates down after room cools)
// - Source: Recommend.my, Sifu Engineering, Hisense Malaysia catalogue
// - Other appliances: Malaysian consumer electronics typical ratings
// - Age penalty: 2%/year capped at 20% (HVAC industry standard)

// ── AIRCOND WATTAGE ────────────────────────────────────────
// TNB Official HP→Watt: 1HP = 746W (hec.tnb.com.my)
// Non-inverter actual = rated × 1.15 (runs full load always)
// Inverter actual avg = rated × 0.65 (modulates after cooldown)
// Verified: 1.0HP non-inverter ~860W (Daikin FTV-P, Sifu Engineering)
//           1.5HP inverter ~750W avg actual (Recommend.my)

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
  // Find closest HP key
  const keys = Object.keys(AIRCOND_RATED_WATT).map(Number);
  const closest = keys.reduce((prev, curr) =>
    Math.abs(curr - hpKey) < Math.abs(prev - hpKey) ? curr : prev
  );
  const rated = AIRCOND_RATED_WATT[closest] || (hpKey * 746);
  // Non-inverter: full load always = 115% of rated
  // Inverter: average running = 65% of rated (modulates)
  return inverter ? Math.round(rated * 0.65) : Math.round(rated * 1.15);
};

// ── OTHER APPLIANCE WATTAGE ────────────────────────────────
// Sources: TNB HEC, Malaysian consumer electronics typical ratings
// Refrigerator: 150-200W typical Malaysian household (running avg ~30% duty cycle)
// Washing Machine: 500W (non-inverter), 350W (inverter)
// TV: 60W modern LED (was 100W — old CRT value)
// Water Heater: 3500W instant type (most common in Malaysia)
// Rice Cooker: 600W cooking, ~50W warm (avg 600W for cooking period)
// Microwave: 1000W
// Lights: 10W per LED bulb (9-15W range, 10W average)
// Water Pump: 375W (0.5HP typical submersible)
// Computer: 200W desktop, 60W laptop (use 200W as conservative)
// Fan: 50W (ceiling/stand fan typical)
// Iron: 1000W
// Other: 100W

const APPLIANCE_WATTAGE = {
  REFRIGERATOR:    { wattage: 55   }, // 150-200W rated × 30% duty cycle = ~55W avg running
  WASHING_MACHINE: { wattage: 500  }, // 500W typical non-inverter cycle average
  TV:              { wattage: 60   }, // Modern LED TV 40-55" — 60W avg
  WATER_HEATER:    { wattage: 3500 }, // Instant water heater — 3500W
  RICE_COOKER:     { wattage: 600  }, // 600W cooking mode
  MICROWAVE:       { wattage: 1000 }, // 1000W typical
  LIGHTS:          { wattage: 10   }, // LED bulb — 10W per unit
  WATER_PUMP:      { wattage: 375  }, // 0.5HP pump = 373W
  COMPUTER:        { wattage: 200  }, // Desktop PC — 200W
  FAN:             { wattage: 50   }, // Ceiling/stand fan — 50W
  IRON:            { wattage: 1000 }, // Steam iron — 1000W
  OTHER:           { wattage: 100  }  // Unknown — conservative 100W
};

// ── CENTRAL AIRCOND (INSTITUTIONAL) ───────────────────────
// 1 RT = 3.517 kW, COP 4.0 → input power = RT × 0.879 kW
// Source: ASHRAE, Malaysian central chiller industry standard
const CENTRAL_AIRCOND_RT = {
  SMALL:      { midpointRT: 15  }, // 10-20 RT — surau kecil
  MEDIUM:     { midpointRT: 35  }, // 20-50 RT — masjid biasa
  LARGE:      { midpointRT: 75  }, // 50-100 RT — masjid negeri
  VERY_LARGE: { midpointRT: 150 }  // >100 RT — kompleks masjid
};

const getCentralAircondWattage = (sizeCategory) => {
  const rt = CENTRAL_AIRCOND_RT[sizeCategory]?.midpointRT || 35;
  // Input power = RT × 3.517 kW ÷ COP(4.0) = RT × 0.879 kW
  return Math.round(rt * 0.879 * 1000); // returns Watts
};

// ── MASJID PRAYER TIME HOURS (HARDCODED MALAYSIAN STANDARD) ──
// Aircond ON for all 5 prayers: Subuh(2) + Zohor(1.5) + Asar(1) + Maghrib(1) + Isyak(1) = 6.5hrs
// Lights ON for 3 dark prayers: Subuh(2) + Maghrib(1) + Isyak(1.5) = 4.5hrs
// Water heater for wudhu all 5 prayers: avg 30min × 5 = 2.5hrs
// Jumaat extra: 2hrs × 4 Fridays = 8hrs/month extra aircond
// Monthly aircond hours = (6.5 × 30) + 8 = 203hrs/month
// Daily equivalent = 203 ÷ 30 = 6.77hrs/day
const PRAYER_HOURS = {
  AIRCOND:      6.77, // daily avg including Jumaat
  LIGHTS:       4.5,  // dark prayers only
  WATER_HEATER: 2.5   // wudhu for all 5 prayers
};

// ── AGE EFFICIENCY PENALTY ─────────────────────────────────
// Source: General HVAC industry standard
// Well-maintained unit: 1-2% degradation per year
// We use 2%/year as conservative estimate
// Capped at 20% maximum (beyond 10 years, replacement advised anyway)
const getAgePenalty = (ageYears) => {
  const penalty = Math.min(ageYears * 0.02, 0.20);
  return 1 + penalty;
};

const analyseBleeders = (appliances, totalKwh, effectiveRateSen, billingPeriodDays = 30) => {
  const results = [];
  let totalEstimatedKwh = 0;

  appliances.forEach(appliance => {
    let wattage = 0;

    if (appliance.applianceType === 'AIRCOND') {
      wattage = getAircondWattage(appliance.hp || 1.5, appliance.inverter || false);
    } else if (appliance.applianceType === 'CENTRAL_AIRCOND') {
      // Central chiller — wattage already computed from RT during onboarding
      // Stored in appliance.wattage directly
      wattage = appliance.wattage || getCentralAircondWattage('MEDIUM');
    } else if (appliance.wattage && appliance.wattage > 0) {
      // User declared actual wattage — use directly
      wattage = parseFloat(appliance.wattage);
    } else {
      // Use lookup table
      wattage = APPLIANCE_WATTAGE[appliance.applianceType]?.wattage || 100;
    }

    // Apply age penalty
    const agePenalty = getAgePenalty(appliance.ageYears || 0);
    const adjustedWattage = wattage * agePenalty;

    // Monthly kWh
    const monthlyKwh = (adjustedWattage * appliance.avgHoursDaily * billingPeriodDays * (appliance.qty || 1)) / 1000;

    // Monthly cost
    const monthlyCostMyr = monthlyKwh * (effectiveRateSen / 100);

    // ── SAVING TIPS ─────────────────────────────────────────
    let immediateSavingMyr = 0;
    let immediateTip = '';
    let longtermSavingMyr = 0;
    let longtermTip = '';

    if (appliance.applianceType === 'CENTRAL_AIRCOND') {
      // Central chiller institutional missions
      // Main saving = switch off between prayers
      const wastedHours = appliance.avgHoursDaily - PRAYER_HOURS.AIRCOND;
      if (wastedHours > 0) {
        const wastedKwh = (adjustedWattage * wastedHours * billingPeriodDays) / 1000;
        immediateSavingMyr = Math.max(wastedKwh * (effectiveRateSen / 100), 0);
        immediateTip = `Switch off central aircond between prayers. Running ${appliance.avgHoursDaily.toFixed(1)}hrs/day but only ${PRAYER_HOURS.AIRCOND}hrs needed — save est. RM${immediateSavingMyr.toFixed(0)}/month immediately`;
      } else {
        immediateSavingMyr = monthlyCostMyr * 0.10;
        immediateTip = `Set thermostat to 24°C — each 1°C lower increases consumption 10%. Save est. RM${immediateSavingMyr.toFixed(0)}/month`;
      }
      longtermSavingMyr = monthlyCostMyr * 0.15;
      longtermTip = `Install BMS (Building Management System) timer — auto-on 30 mins before prayer, auto-off 15 mins after. ROI typically 12-18 months.`;

    } else if (appliance.applianceType === 'AIRCOND') {
      if (!appliance.inverter) {
        // Non-inverter aircond
        // Immediate — reduce by 2hrs/day
        const reducedKwh = (adjustedWattage * Math.max(appliance.avgHoursDaily - 2, 0) * billingPeriodDays * (appliance.qty || 1)) / 1000;
        immediateSavingMyr = Math.max((monthlyKwh - reducedKwh) * (effectiveRateSen / 100), 0);
        immediateTip = `Reduce usage by 2hrs/day — save est. RM${immediateSavingMyr.toFixed(0)}/month immediately`;

        // Long term — switch to inverter (saves ~43% based on Hisense catalogue data)
        longtermSavingMyr = monthlyCostMyr * 0.43;
        longtermTip = `Switch to inverter unit — save est. RM${longtermSavingMyr.toFixed(0)}/month long term. Payback typically 2-3 years.`;

      } else {
        // Inverter aircond
        // Immediate — set to 25°C (each 1°C lower = ~10% more consumption)
        immediateSavingMyr = monthlyCostMyr * 0.10;
        immediateTip = `Set to 25°C instead of lower — save est. RM${immediateSavingMyr.toFixed(0)}/month immediately`;

        // Long term — reduce hours by 1hr/day
        const reducedKwh = (adjustedWattage * Math.max(appliance.avgHoursDaily - 1, 0) * billingPeriodDays * (appliance.qty || 1)) / 1000;
        longtermSavingMyr = Math.max((monthlyKwh - reducedKwh) * (effectiveRateSen / 100), 0);
        longtermTip = `Reduce by 1hr/day — save est. RM${longtermSavingMyr.toFixed(0)}/month`;
      }

    } else if (appliance.applianceType === 'REFRIGERATOR') {
      // Immediate — ensure door seal + coil clean
      immediateSavingMyr = monthlyCostMyr * 0.10;
      immediateTip = `Clean condenser coils + check door seal — save est. RM${immediateSavingMyr.toFixed(0)}/month immediately`;

      // Long term — upgrade if old
      if (appliance.ageYears >= 8) {
        longtermSavingMyr = monthlyCostMyr * 0.30;
        longtermTip = `Unit is ${Math.floor(appliance.ageYears)} years old — upgrade to 4-5 star model, save est. RM${longtermSavingMyr.toFixed(0)}/month`;
      } else {
        longtermSavingMyr = monthlyCostMyr * 0.10;
        longtermTip = `Set temperature to 4°C fridge / -18°C freezer for optimal efficiency`;
      }

    } else if (appliance.applianceType === 'WATER_HEATER') {
      // Immediate — switch off when not in use
      immediateSavingMyr = monthlyCostMyr * 0.30;
      immediateTip = `Switch off water heater when not in use — save est. RM${immediateSavingMyr.toFixed(0)}/month immediately`;

      longtermSavingMyr = monthlyCostMyr * 0.15;
      longtermTip = `Install timer switch — auto-on 30 mins before shower time only`;

    } else if (appliance.applianceType === 'WASHING_MACHINE') {
      // Immediate — wash full loads only
      immediateSavingMyr = monthlyCostMyr * 0.20;
      immediateTip = `Wash full loads only — save est. RM${immediateSavingMyr.toFixed(0)}/month immediately`;

      longtermSavingMyr = monthlyCostMyr * 0.15;
      longtermTip = `Use cold water wash — saves energy on heating`;

    } else if (appliance.applianceType === 'TV') {
      // Immediate — disable standby
      immediateSavingMyr = monthlyCostMyr * 0.10;
      immediateTip = `Switch off completely instead of standby — save est. RM${immediateSavingMyr.toFixed(0)}/month`;

      longtermSavingMyr = monthlyCostMyr * 0.10;
      longtermTip = `Reduce screen brightness by 30% — noticeable savings over time`;

    } else if (appliance.applianceType === 'LIGHTS') {
      // Immediate — switch off unused rooms
      immediateSavingMyr = monthlyCostMyr * 0.20;
      immediateTip = `Switch off lights in empty rooms — save est. RM${immediateSavingMyr.toFixed(0)}/month immediately`;

      if (appliance.ageYears >= 3) {
        longtermSavingMyr = monthlyCostMyr * 0.50;
        longtermTip = `Replace with latest LED — uses 50% less than older fluorescent tubes`;
      } else {
        longtermSavingMyr = monthlyCostMyr * 0.10;
        longtermTip = `Install motion sensors for common areas`;
      }

    } else if (appliance.ageYears >= 7) {
      // Old appliance
      immediateSavingMyr = monthlyCostMyr * 0.08;
      immediateTip = `Service unit now — old appliance running inefficiently, save est. RM${immediateSavingMyr.toFixed(0)}/month`;

      longtermSavingMyr = monthlyCostMyr * 0.25;
      longtermTip = `Unit is ${Math.floor(appliance.ageYears)} years old — replace with energy-efficient model, save est. RM${longtermSavingMyr.toFixed(0)}/month`;

    } else {
      // Default
      immediateSavingMyr = monthlyCostMyr * 0.08;
      immediateTip = `Reduce usage by 1hr/day — save est. RM${immediateSavingMyr.toFixed(0)}/month`;

      longtermSavingMyr = monthlyCostMyr * 0.10;
      longtermTip = `Switch off standby mode — saves electricity passively`;
    }

    const potentialSavingMyr = immediateSavingMyr;
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
      estimatedKwh: Math.round(monthlyKwh * 10) / 10,
      estimatedCostMyr: Math.round(monthlyCostMyr * 100) / 100,
      potentialSavingMyr: Math.round(potentialSavingMyr * 100) / 100,
      savingTip: immediateTip,
      immediateTip,
      immediateSavingMyr: Math.round(immediateSavingMyr * 100) / 100,
      longtermTip,
      longtermSavingMyr: Math.round(longtermSavingMyr * 100) / 100,
      shareOfBill: 0
    });
  });

  // Sort by estimated cost descending
  results.sort((a, b) => b.estimatedCostMyr - a.estimatedCostMyr);

  // Calculate share of total estimated cost
  const totalEstimatedCost = results.reduce((sum, r) => sum + r.estimatedCostMyr, 0);
  results.forEach(r => {
    r.shareOfBill = totalEstimatedCost > 0
      ? Math.round((r.estimatedCostMyr / totalEstimatedCost) * 100)
      : 0;
  });

  const totalPotentialSaving = results.reduce((sum, r) => sum + r.potentialSavingMyr, 0);

  return {
    bleeders: results,
    topBleeder: results[0] || null,
    totalEstimatedKwh: Math.round(totalEstimatedKwh * 10) / 10,
    totalPotentialSavingMyr: Math.round(totalPotentialSaving * 100) / 100,
    coveragePercent: totalKwh > 0
      ? Math.round((totalEstimatedKwh / totalKwh) * 100)
      : 0
  };
};

const generateMissions = (bleederResult, billAnalysis, language = 'EN') => {
  if (!bleederResult) return [];

  const missions = [];
  const { bleeders, topBleeder } = bleederResult;
  const { flags } = billAnalysis;

  // Mission 1 — Immediate action on top bleeder
  if (topBleeder && topBleeder.immediateSavingMyr > 0) {
    missions.push({
      priority: 1,
      icon: '⚡',
      title: language === 'BM' ? 'Tindakan Segera — Kos Sifar' : 'Do This NOW — Zero Cost',
      description: topBleeder.immediateTip,
      estimatedSavingMyr: topBleeder.immediateSavingMyr,
      appliance: `${topBleeder.roomName} — ${topBleeder.applianceType}`
    });
  }

  // Mission 2 — Threshold warning
  if (flags && flags.nearRetailThreshold) {
    missions.push({
      priority: 2,
      icon: '⚠️',
      title: language === 'BM' ? 'Elak Caj Runcit RM10' : 'Avoid RM10 Retail Charge',
      description: language === 'BM'
        ? 'Anda hampir 600 kWh. Kurangkan penggunaan untuk elak Caj Runcit RM10 + AFA + SST bulan ini.'
        : 'You are near the 600 kWh threshold. Reduce usage now to avoid RM10 Retail Charge + AFA + SST.',
      estimatedSavingMyr: 10,
      appliance: null
    });
  }

  // Mission 3 — Long term action on top bleeder
  if (topBleeder && topBleeder.longtermSavingMyr > 0) {
    missions.push({
      priority: 3,
      icon: '🎯',
      title: language === 'BM' ? 'Pelaburan Jangka Panjang' : 'Long Term — Best ROI',
      description: topBleeder.longtermTip,
      estimatedSavingMyr: topBleeder.longtermSavingMyr,
      appliance: `${topBleeder.roomName} — ${topBleeder.applianceType}`
    });
  }

  // Mission 4 — Second biggest bleeder
  if (bleeders.length > 1) {
    const second = bleeders[1];
    missions.push({
      priority: 4,
      icon: '💡',
      title: language === 'BM' ? 'Serang Pembazir Ke-2' : 'Attack Your #2 Bleeder',
      description: second.immediateTip,
      estimatedSavingMyr: second.immediateSavingMyr,
      appliance: `${second.roomName} — ${second.applianceType}`
    });
  }

  return missions.slice(0, 3);
};

// ── GENERATE INSTITUTIONAL APPLIANCE PROFILE ───────────────
// Converts 5-question onboarding answers into appliance array
// Called from billController when user is INSTITUTIONAL
const generateInstitutionalProfile = (user) => {
  const appliances = [];

  // Building age in years (midpoint of category)
  const buildingAgeMap = { 1: 2, 2: 10, 3: 18 };
  const ageYears = buildingAgeMap[user.buildingAge] || 10;

  // ── AIRCOND ─────────────────────────────────────────────
  if (user.aircondSystemType === 'SPLIT') {
    // Split units — from Appliance table (user entered qty + HP)
    // Already in DB — no need to generate
  } else if (user.aircondSystemType === 'CENTRAL') {
    // Central chiller — generate from centralAircondSize
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

  // ── LIGHTS ───────────────────────────────────────────────
  const floorAreaM2Map = { 1: 18.6, 2: 32.5, 3: 69.7, 4: 139.4 };
  const lightWperM2Map = { 1: 10, 2: 20, 3: 15 }; // LED/Fluorescent/Mixed
  const floorM2 = floorAreaM2Map[user.floorAreaCategory] || 32.5;
  const wPerM2 = lightWperM2Map[user.lightType] || 15;
  const lightingWattage = Math.round(floorM2 * wPerM2);

  appliances.push({
    roomName: 'Dewan Solat',
    applianceType: 'LIGHTS',
    wattage: lightingWattage,
    ageYears: ageYears,
    qty: 1,
    avgHoursDaily: PRAYER_HOURS.LIGHTS,
    inverter: false,
    hp: null,
    brand: null
  });

  // ── WATER HEATER ─────────────────────────────────────────
  // Most masjid have at least 1 water heater for wudhu
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

  // ── WATER PUMP ───────────────────────────────────────────
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

// ── CALCULATE EXPECTED VS ACTUAL KWH (INSTITUTIONAL) ────────
// Expected = what they should use based on prayer schedule
// Actual = from TNB bill
// Gap = waste = the institutional bleeder
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
  const wastedAmountMyr = Math.round(wastedKwh * (effectiveRateSen / 100) * 100) / 100;

  return {
    expectedKwhMonthly: Math.round(expectedKwh * 10) / 10,
    wastedKwhMonthly: Math.round(wastedKwh * 10) / 10,
    wastedAmountMyr,
    wastePercent: actualKwh > 0 ? Math.round((wastedKwh / actualKwh) * 100) : 0
  };
};

module.exports = {
  analyseBleeders,
  generateMissions,
  generateInstitutionalProfile,
  calculateInstitutionalWaste,
  PRAYER_HOURS
};