// JIMAT Bleeder Engine
// Cross-references appliance profile against actual kWh
// to identify the biggest cost culprits

const APPLIANCE_WATTAGE = {
  AIRCOND: {
    getWattage: (hp, inverter) => {
      const baseWattage = {
        0.5:  inverter ? 400  : 550,
        0.75: inverter ? 550  : 750,
        1.0:  inverter ? 700  : 900,
        1.5:  inverter ? 900  : 1300,
        2.0:  inverter ? 1300 : 1800,
        2.5:  inverter ? 1700 : 2200,
      };
      const hpKey = parseFloat(hp);
      return baseWattage[hpKey] || (hpKey * 900);
    }
  },
  WATER_HEATER: {
    getWattage: () => 3500
  },
  REFRIGERATOR:    { wattage: 150  },
  WASHING_MACHINE: { wattage: 500  },
  TV:              { wattage: 100  },
  LIGHTS:          { wattage: 15   },
  WATER_PUMP:      { wattage: 370  },
  RICE_COOKER:     { wattage: 600  },
  MICROWAVE:       { wattage: 1000 },
  OVEN:            { wattage: 2000 },
  COMPUTER:        { wattage: 200  },
  OTHER:           { wattage: 100  }
};

const AGE_EFFICIENCY_PENALTY = (ageYears) => {
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
        wattage = APPLIANCE_WATTAGE.WATER_HEATER.getWattage();
        break;
      default:
        wattage = APPLIANCE_WATTAGE[appliance.applianceType]?.wattage || 100;
    }

    const agePenalty = AGE_EFFICIENCY_PENALTY(appliance.ageYears || 0);
    const adjustedWattage = wattage * agePenalty;
    const monthlyKwh = (adjustedWattage * appliance.avgHoursDaily * billingPeriodDays * appliance.qty) / 1000;
    const monthlyCostMyr = monthlyKwh * (effectiveRateSen / 100);

    // Immediate saving tip — zero cost action this month
    let immediateSavingMyr = 0;
    let immediateTip = '';

    // Long term saving tip — investment required
    let longtermSavingMyr = 0;
    let longtermTip = '';

    if (appliance.applianceType === 'AIRCOND' && !appliance.inverter) {
      // Immediate — reduce by 2hrs/day
      const reducedKwh = (adjustedWattage * (appliance.avgHoursDaily - 2) * billingPeriodDays * appliance.qty) / 1000;
      immediateSavingMyr = (monthlyKwh - reducedKwh) * (effectiveRateSen / 100);
      immediateTip = `Reduce usage by 2hrs/day — save est. RM${Math.round(immediateSavingMyr)}/month immediately`;

      // Long term — switch to inverter
      const inverterWattage = APPLIANCE_WATTAGE.AIRCOND.getWattage(appliance.hp || 1.5, true);
      const inverterKwh = (inverterWattage * appliance.avgHoursDaily * billingPeriodDays * appliance.qty) / 1000;
      longtermSavingMyr = (monthlyKwh - inverterKwh) * (effectiveRateSen / 100);
      longtermTip = `Switch to inverter unit — save est. RM${Math.round(longtermSavingMyr)}/month long term`;

    } else if (appliance.applianceType === 'AIRCOND' && appliance.inverter) {
      // Immediate — set to 25°C
      immediateSavingMyr = monthlyCostMyr * 0.15;
      immediateTip = `Set to 25°C instead of lower — save est. RM${Math.round(immediateSavingMyr)}/month immediately`;

      // Long term — reduce hours
      longtermSavingMyr = monthlyCostMyr * 0.10;
      longtermTip = `Reduce by 1hr/day — save est. RM${Math.round(longtermSavingMyr)}/month`;

    } else if (appliance.ageYears > 5) {
      // Immediate — service the unit
      immediateSavingMyr = monthlyCostMyr * 0.10;
      immediateTip = `Service unit now — save est. RM${Math.round(immediateSavingMyr)}/month immediately`;

      // Long term — replace old unit
      longtermSavingMyr = monthlyCostMyr * 0.20;
      longtermTip = `Unit is ${Math.floor(appliance.ageYears)} years old — replace with energy-efficient model, save est. RM${Math.round(longtermSavingMyr)}/month`;

    } else {
      // Default — reduce usage
      immediateSavingMyr = monthlyCostMyr * 0.10;
      immediateTip = `Reduce usage by 1hr/day — save est. RM${Math.round(immediateSavingMyr)}/month`;

      longtermSavingMyr = monthlyCostMyr * 0.15;
      longtermTip = `Switch off standby mode — save est. RM${Math.round(longtermSavingMyr)}/month long term`;
    }

    // Primary saving tip = immediate action
    const potentialSavingMyr = immediateSavingMyr;
    const savingTip = immediateTip;

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
      immediateTip,
      immediateSavingMyr: Math.round(immediateSavingMyr * 100) / 100,
      longtermTip,
      longtermSavingMyr: Math.round(longtermSavingMyr * 100) / 100,
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
  const missions = [];
  const { bleeders, topBleeder } = bleederResult;
  const { flags } = billAnalysis;

  // Mission 1 — Immediate action on top bleeder (zero cost this month)
  if (topBleeder) {
    missions.push({
      priority: 1,
      icon: '⚡',
      title: language === 'BM' ? 'Tindakan Segera — Bulan Ini' : 'Do This NOW — Zero Cost',
      description: topBleeder.immediateTip,
      estimatedSavingMyr: topBleeder.immediateSavingMyr,
      appliance: `${topBleeder.roomName} — ${topBleeder.applianceType}`
    });
  }

  // Mission 2 — Threshold warning
  if (flags.nearRetailThreshold) {
    missions.push({
      priority: 2,
      icon: '⚠️',
      title: language === 'BM' ? 'Elak Caj Runcit RM10' : 'Avoid RM10 Retail Charge',
      description: language === 'BM'
        ? 'Anda hampir 600kWh. Kurangkan penggunaan untuk elak caj RM10 + AFA bulan ini.'
        : 'You are close to 600kWh threshold. Reduce usage to avoid RM10 Retail Charge + AFA this month.',
      estimatedSavingMyr: 10,
      appliance: null
    });
  }

  // Mission 3 — Long term action on top bleeder (investment)
  if (topBleeder && topBleeder.longtermTip) {
    missions.push({
      priority: 3,
      icon: '🎯',
      title: language === 'BM' ? 'Pelaburan Jangka Panjang' : 'Long Term — Best ROI',
      description: topBleeder.longtermTip,
      estimatedSavingMyr: topBleeder.longtermSavingMyr,
      appliance: `${topBleeder.roomName} — ${topBleeder.applianceType}`
    });
  }

  // Mission 4 — Second biggest bleeder immediate action
  if (bleeders.length > 1) {
    const second = bleeders[1];
    missions.push({
      priority: 4,
      icon: '💡',
      title: language === 'BM' ? 'Jimat di Tempat Lain' : 'Attack Your #2 Bleeder',
      description: second.immediateTip,
      estimatedSavingMyr: second.immediateSavingMyr,
      appliance: `${second.roomName} — ${second.applianceType}`
    });
  }

  // Mission 5 — Age warning
  const oldAppliances = bleeders.filter(b => b.ageYears > 7);
  if (oldAppliances.length > 0) {
    missions.push({
      priority: 5,
      icon: '🔧',
      title: language === 'BM' ? 'Servis Peralatan Lama' : 'Service Ageing Appliances',
      description: language === 'BM'
        ? `${oldAppliances.length} peralatan berumur >7 tahun. Servis segera boleh jimat sehingga 10% kos bulan ini.`
        : `${oldAppliances.length} appliance(s) over 7 years old. Service now to save up to 10% in running costs this month.`,
      estimatedSavingMyr: oldAppliances.reduce((s, a) => s + a.immediateSavingMyr, 0),
      appliance: null
    });
  }

  return missions.slice(0, 3);
};

module.exports = { analyseBleeders, generateMissions };