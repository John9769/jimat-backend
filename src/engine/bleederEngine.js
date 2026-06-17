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
      // Use HP + inverter flag for aircond
      wattage = getAircondWattage(appliance.hp || 1.5, appliance.inverter || false);
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

    if (appliance.applianceType === 'AIRCOND') {
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

module.exports = { analyseBleeders, generateMissions };