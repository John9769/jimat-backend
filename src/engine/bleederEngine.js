// JIMAT Bleeder Engine
// Cross-references appliance profile against actual kWh
// to identify the biggest cost culprits

// Appliance wattage database (watts)
const APPLIANCE_WATTAGE = {
  AIRCOND: {
    // HP to wattage — inverter vs non-inverter
    getWattage: (hp, inverter) => {
      const baseWattage = {
        0.5: inverter ? 400  : 550,
        0.75: inverter ? 550  : 750,
        1.0: inverter ? 700  : 900,
        1.5: inverter ? 900  : 1300,
        2.0: inverter ? 1300 : 1800,
        2.5: inverter ? 1700 : 2200,
      };
      const hpKey = parseFloat(hp);
      return baseWattage[hpKey] || (hpKey * 900);
    }
  },
  WATER_HEATER: {
    getWattage: (type) => {
      return type === 'instant' ? 3500 : 2000; // instant vs storage
    }
  },
  REFRIGERATOR: { wattage: 150 },
  WASHING_MACHINE: { wattage: 500 },
  TV: { wattage: 100 },
  LIGHTS: { wattage: 15 }, // per LED bulb
  WATER_PUMP: { wattage: 370 },
  RICE_COOKER: { wattage: 600 },
  MICROWAVE: { wattage: 1000 },
  OVEN: { wattage: 2000 },
  COMPUTER: { wattage: 200 },
  OTHER: { wattage: 100 }
};

const AGE_EFFICIENCY_PENALTY = (ageYears) => {
  // Older appliances consume more — 5% degradation per year, max 40%
  const penalty = Math.min(ageYears * 0.05, 0.40);
  return 1 + penalty;
};

const analyseBleeders = (appliances, totalKwh, effectiveRateSen, billingPeriodDays = 30) => {
  const results = [];
  let totalEstimatedKwh = 0;

  appliances.forEach(appliance => {
    let wattage = 0;

    switch (appliance.applianceType) {
      case 'AIRCOND':
        wattage = APPLIANCE_WATTAGE.AIRCOND.getWattage(appliance.hp || 1.5, appliance.inverter);
        break;
      case 'WATER_HEATER':
        wattage = APPLIANCE_WATTAGE.WATER_HEATER.getWattage('instant');
        break;
      default:
        wattage = APPLIANCE_WATTAGE[appliance.applianceType]?.wattage || 100;
    }

    // Apply age penalty
    const agePenalty = AGE_EFFICIENCY_PENALTY(appliance.ageYears || 0);
    const adjustedWattage = wattage * agePenalty;

    // Monthly kWh = (wattage × hours/day × days) / 1000
    const monthlyKwh = (adjustedWattage * appliance.avgHoursDaily * billingPeriodDays * appliance.qty) / 1000;

    // Monthly cost
    const monthlyCostMyr = monthlyKwh * (effectiveRateSen / 100);

    // Potential saving if optimised
    // For aircond: compare inverter vs non-inverter
    let potentialSavingMyr = 0;
    let savingTip = '';

    if (appliance.applianceType === 'AIRCOND' && !appliance.inverter) {
      const inverterWattage = APPLIANCE_WATTAGE.AIRCOND.getWattage(appliance.hp || 1.5, true);
      const inverterKwh = (inverterWattage * appliance.avgHoursDaily * billingPeriodDays * appliance.qty) / 1000;
      potentialSavingMyr = (monthlyKwh - inverterKwh) * (effectiveRateSen / 100);
      savingTip = `Switch to inverter unit — save est. RM${Math.round(potentialSavingMyr)}/month`;
    } else if (appliance.applianceType === 'AIRCOND' && appliance.inverter) {
      // Temp optimisation — 25°C vs 20°C saves ~15%
      potentialSavingMyr = monthlyCostMyr * 0.15;
      savingTip = `Set to 25°C instead of lower — save est. RM${Math.round(potentialSavingMyr)}/month`;
    } else if (appliance.ageYears > 5) {
      potentialSavingMyr = monthlyCostMyr * 0.20;
      savingTip = `Unit is ${Math.floor(appliance.ageYears)} years old — service or replace to save est. RM${Math.round(potentialSavingMyr)}/month`;
    } else {
      potentialSavingMyr = monthlyCostMyr * 0.10;
      savingTip = `Reduce usage by 1hr/day — save est. RM${Math.round(potentialSavingMyr)}/month`;
    }

    totalEstimatedKwh += monthlyKwh;

    results.push({
      applianceId: appliance.id,
      roomName: appliance.roomName,
      applianceType: appliance.applianceType,
      brand: appliance.brand || '',
      qty: appliance.qty,
      inverter: appliance.inverter,
      ageYears: appliance.ageYears,
      avgHoursDaily: appliance.avgHoursDaily,
      estimatedKwh: Math.round(monthlyKwh * 10) / 10,
      estimatedCostMyr: Math.round(monthlyCostMyr * 100) / 100,
      potentialSavingMyr: Math.round(potentialSavingMyr * 100) / 100,
      savingTip,
      shareOfBill: 0 // calculated after loop
    });
  });

  // Sort by cost descending — biggest bleeder first
  results.sort((a, b) => b.estimatedCostMyr - a.estimatedCostMyr);

  // Calculate share of bill
  const totalEstimatedCost = results.reduce((sum, r) => sum + r.estimatedCostMyr, 0);
  results.forEach(r => {
    r.shareOfBill = totalEstimatedCost > 0
      ? Math.round((r.estimatedCostMyr / totalEstimatedCost) * 100)
      : 0;
  });

  // Total potential saving
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

// Generate monthly missions from bleeder analysis
const generateMissions = (bleederResult, billAnalysis, language = 'EN') => {
  const missions = [];
  const { bleeders, topBleeder } = bleederResult;
  const { flags } = billAnalysis;

  // Mission 1 — Top bleeder action
  if (topBleeder) {
    missions.push({
      priority: 1,
      icon: '🎯',
      title: language === 'BM' ? 'Kurangkan Pembaziran Utama' : 'Attack Your #1 Bleeder',
      description: topBleeder.savingTip,
      estimatedSavingMyr: topBleeder.potentialSavingMyr,
      appliance: `${topBleeder.roomName} — ${topBleeder.applianceType}`
    });
  }

  // Mission 2 — Threshold warning/opportunity
  if (flags.nearRetailThreshold) {
    missions.push({
      priority: 2,
      icon: '⚠️',
      title: language === 'BM' ? 'Elak Caj Runcit RM10' : 'Avoid RM10 Retail Charge',
      description: language === 'BM'
        ? `Anda hampir 600kWh. Kurangkan penggunaan untuk elak caj RM10 + AFA bulan ini.`
        : `You're close to 600kWh threshold. Reduce usage to avoid RM10 Retail Charge + AFA this month.`,
      estimatedSavingMyr: 10,
      appliance: null
    });
  }

  // Mission 3 — Second biggest bleeder
  if (bleeders.length > 1) {
    const second = bleeders[1];
    missions.push({
      priority: 3,
      icon: '💡',
      title: language === 'BM' ? 'Jimat di Bilik Lain' : 'Target Your #2 Bleeder',
      description: second.savingTip,
      estimatedSavingMyr: second.potentialSavingMyr,
      appliance: `${second.roomName} — ${second.applianceType}`
    });
  }

  // Mission 4 — Age warning
  const oldAppliances = bleeders.filter(b => b.ageYears > 7);
  if (oldAppliances.length > 0) {
    missions.push({
      priority: 4,
      icon: '🔧',
      title: language === 'BM' ? 'Servis Peralatan Lama' : 'Service Ageing Appliances',
      description: language === 'BM'
        ? `${oldAppliances.length} peralatan berumur >7 tahun. Servis boleh jimat sehingga 20% kos.`
        : `${oldAppliances.length} appliance(s) over 7 years old. Servicing can save up to 20% in running costs.`,
      estimatedSavingMyr: oldAppliances.reduce((s, a) => s + a.potentialSavingMyr, 0),
      appliance: null
    });
  }

  return missions.slice(0, 3); // Max 3 missions
};

module.exports = { analyseBleeders, generateMissions };