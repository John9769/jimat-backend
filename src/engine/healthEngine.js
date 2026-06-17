// JIMAT Health Engine
// Calculates electricity health score 0-100 for every report
// Based on 2-bill comparison — requires both current and reference data
//
// SCORING BREAKDOWN:
// Factor 1 — Threshold Status    (25 pts) kWh vs 600 threshold
// Factor 2 — Month vs Month Trend (25 pts) kWh change direction
// Factor 3 — Bleeder Concentration (25 pts) top bleeder share
// Factor 4 — AFA Exposure        (15 pts) exposure to AFA surcharge
// Factor 5 — Bill Change Cause   (10 pts) behaviour vs government

const round2 = (val) => Math.round(val * 100) / 100;

const calculateHealthScore = ({
  currentKwh,          // Current month kWh
  previousKwh,         // Reference month kWh
  currentCajSemasa,    // Current month caj semasa (RM)
  previousCajSemasa,   // Reference month caj semasa (RM)
  currentAfaCharge,    // Current month AFA charge (RM)
  previousAfaCharge,   // Reference month AFA charge (RM)
  bleederResult,       // From bleeder engine
  lang = 'EN'
}) => {

  // ── FACTOR 1: THRESHOLD STATUS (25 pts) ──────────────
  // Is user below 600 kWh threshold?
  // Below = no retail charge, no AFA, no SST
  let factor1 = 0;
  let factor1Detail = '';

  if (currentKwh <= 600) {
    factor1 = 25;
    factor1Detail = lang === 'BM'
      ? 'Cemerlang! Penggunaan bawah 600 kWh — Caj Runcit + AFA + SST dikecualikan.'
      : 'Excellent! Usage below 600 kWh — Retail Charge + AFA + SST all waived.';
  } else if (currentKwh <= 650) {
    factor1 = 15;
    factor1Detail = lang === 'BM'
      ? `Hampir! Hanya ${Math.round(currentKwh - 600)} kWh melebihi had 600. Kurangkan sedikit lagi untuk jimat Caj Runcit + AFA + SST.`
      : `So close! Only ${Math.round(currentKwh - 600)} kWh above 600 threshold. Reduce a little more to waive Retail + AFA + SST.`;
  } else if (currentKwh <= 800) {
    factor1 = 10;
    factor1Detail = lang === 'BM'
      ? `${Math.round(currentKwh - 600)} kWh melebihi had 600 kWh. Sasaran: kurangkan penggunaan untuk elak caj tambahan.`
      : `${Math.round(currentKwh - 600)} kWh above 600 threshold. Target: reduce usage to avoid extra charges.`;
  } else if (currentKwh <= 1500) {
    factor1 = 5;
    factor1Detail = lang === 'BM'
      ? `Penggunaan tinggi: ${Math.round(currentKwh)} kWh. Tindakan segera diperlukan.`
      : `High usage: ${Math.round(currentKwh)} kWh. Immediate action needed.`;
  } else {
    factor1 = 0;
    factor1Detail = lang === 'BM'
      ? `Penggunaan kritikal: ${Math.round(currentKwh)} kWh. Kadar tertinggi dikenakan.`
      : `Critical usage: ${Math.round(currentKwh)} kWh. Highest tier rate applied.`;
  }

  // ── FACTOR 2: MONTH VS MONTH TREND (25 pts) ──────────
  // Is kWh going up or down vs reference month?
  let factor2 = 0;
  let factor2Detail = '';
  let kwhChange = 0;
  let kwhChangePercent = 0;

  if (previousKwh && previousKwh > 0) {
    kwhChange = currentKwh - previousKwh;
    kwhChangePercent = round2((kwhChange / previousKwh) * 100);

    if (kwhChangePercent <= -10) {
      factor2 = 25;
      factor2Detail = lang === 'BM'
        ? `Luar biasa! Penggunaan turun ${Math.abs(kwhChangePercent)}% berbanding bulan lepas.`
        : `Outstanding! Usage down ${Math.abs(kwhChangePercent)}% vs last month.`;
    } else if (kwhChangePercent <= -5) {
      factor2 = 20;
      factor2Detail = lang === 'BM'
        ? `Bagus! Penggunaan turun ${Math.abs(kwhChangePercent)}%.`
        : `Good! Usage down ${Math.abs(kwhChangePercent)}%.`;
    } else if (kwhChangePercent <= 0) {
      factor2 = 15;
      factor2Detail = lang === 'BM'
        ? `Sedikit baik. Penggunaan turun ${Math.abs(kwhChangePercent)}%.`
        : `Slightly better. Usage down ${Math.abs(kwhChangePercent)}%.`;
    } else if (kwhChangePercent <= 1) {
      factor2 = 10;
      factor2Detail = lang === 'BM'
        ? 'Penggunaan hampir sama. Cuba kurangkan lagi.'
        : 'Usage almost the same. Try to reduce more.';
    } else if (kwhChangePercent <= 5) {
      factor2 = 5;
      factor2Detail = lang === 'BM'
        ? `Penggunaan naik ${kwhChangePercent}%. Perlu perhatian.`
        : `Usage up ${kwhChangePercent}%. Needs attention.`;
    } else {
      factor2 = 0;
      factor2Detail = lang === 'BM'
        ? `Penggunaan naik ${kwhChangePercent}% — membimbangkan.`
        : `Usage up ${kwhChangePercent}% — concerning.`;
    }
  } else {
    // First report — no previous to compare
    factor2 = 10;
    factor2Detail = lang === 'BM'
      ? 'Laporan pertama anda. Bulan depan kami akan jejak kemajuan anda.'
      : 'Your first report. Next month we will track your progress.';
  }

  // ── FACTOR 3: BLEEDER CONCENTRATION (25 pts) ─────────
  // What % of estimated bill does top bleeder consume?
  // High concentration = high risk = lower score
  let factor3 = 0;
  let factor3Detail = '';

  if (bleederResult && bleederResult.topBleeder) {
    const topShare = bleederResult.topBleeder.shareOfBill || 0;

    if (topShare <= 30) {
      factor3 = 25;
      factor3Detail = lang === 'BM'
        ? `Seimbang. Tiada peralatan tunggal mendominasi penggunaan anda.`
        : `Balanced. No single appliance dominates your usage.`;
    } else if (topShare <= 40) {
      factor3 = 20;
      factor3Detail = lang === 'BM'
        ? `${bleederResult.topBleeder.applianceType} (${bleederResult.topBleeder.roomName}) mengambil ${topShare}% daripada kos anggaran.`
        : `${bleederResult.topBleeder.applianceType} (${bleederResult.topBleeder.roomName}) takes ${topShare}% of estimated cost.`;
    } else if (topShare <= 50) {
      factor3 = 15;
      factor3Detail = lang === 'BM'
        ? `${bleederResult.topBleeder.applianceType} mendominasi pada ${topShare}%. Tindakan diperlukan.`
        : `${bleederResult.topBleeder.applianceType} dominates at ${topShare}%. Action needed.`;
    } else if (topShare <= 60) {
      factor3 = 10;
      factor3Detail = lang === 'BM'
        ? `${bleederResult.topBleeder.applianceType} sangat dominan pada ${topShare}%. Ini pembazir utama anda.`
        : `${bleederResult.topBleeder.applianceType} very dominant at ${topShare}%. This is your main bleeder.`;
    } else {
      factor3 = 0;
      factor3Detail = lang === 'BM'
        ? `Kritikal! ${bleederResult.topBleeder.applianceType} mengambil ${topShare}% daripada kos. Tindakan segera!`
        : `Critical! ${bleederResult.topBleeder.applianceType} takes ${topShare}% of cost. Immediate action!`;
    }
  } else {
    // No appliance profile — cannot calculate
    factor3 = 12; // Neutral
    factor3Detail = lang === 'BM'
      ? 'Kemaskini profil peralatan anda untuk analisis pembazir yang lebih tepat.'
      : 'Update your appliance profile for more accurate bleeder analysis.';
  }

  // ── FACTOR 4: AFA EXPOSURE (15 pts) ──────────────────
  // How much AFA surcharge are they paying?
  // Below 600 kWh = exempt = 15 pts
  let factor4 = 0;
  let factor4Detail = '';

  if (currentKwh <= 600) {
    factor4 = 15;
    factor4Detail = lang === 'BM'
      ? 'AFA dikecualikan sepenuhnya. Penggunaan bawah 600 kWh.'
      : 'AFA fully exempted. Usage below 600 kWh.';
  } else if (currentKwh <= 700) {
    factor4 = 10;
    factor4Detail = lang === 'BM'
      ? `AFA dikenakan pada ${Math.round(currentKwh - 600)} kWh lebihan. Hampir dikecualikan.`
      : `AFA charged on ${Math.round(currentKwh - 600)} kWh excess. Close to exemption.`;
  } else if (currentKwh <= 1000) {
    factor4 = 7;
    factor4Detail = lang === 'BM'
      ? `Pendedahan AFA sederhana. ${Math.round(currentAfaCharge || 0).toFixed(2)} dikenakan bulan ini.`
      : `Moderate AFA exposure. RM${(currentAfaCharge || 0).toFixed(2)} charged this month.`;
  } else if (currentKwh <= 1500) {
    factor4 = 3;
    factor4Detail = lang === 'BM'
      ? `Pendedahan AFA tinggi. RM${(currentAfaCharge || 0).toFixed(2)} dikenakan bulan ini.`
      : `High AFA exposure. RM${(currentAfaCharge || 0).toFixed(2)} charged this month.`;
  } else {
    factor4 = 0;
    factor4Detail = lang === 'BM'
      ? `Pendedahan AFA maksimum. Penggunaan kritikal melebihi 1,500 kWh.`
      : `Maximum AFA exposure. Critical usage above 1,500 kWh.`;
  }

  // ── FACTOR 5: BILL CHANGE CAUSE (10 pts) ─────────────
  // How much of bill change is user behaviour vs AFA?
  // Reward users when bill went up due to AFA not their fault
  let factor5 = 0;
  let factor5Detail = '';

  if (previousCajSemasa && previousCajSemasa > 0) {
    const totalBillChange = currentCajSemasa - previousCajSemasa;
    const afaChange = (currentAfaCharge || 0) - (previousAfaCharge || 0);
    const behaviourChange = totalBillChange - afaChange;

    if (totalBillChange <= 0) {
      // Bill went down
      factor5 = 10;
      factor5Detail = lang === 'BM'
        ? `Bil anda turun RM${Math.abs(round2(totalBillChange))}. Tabiat anda menyumbang kepada penjimatan ini.`
        : `Your bill dropped RM${Math.abs(round2(totalBillChange))}. Your behaviour contributed to this saving.`;
    } else if (behaviourChange <= 0 && afaChange > 0) {
      // Bill went up but ONLY because of AFA
      factor5 = 8;
      factor5Detail = lang === 'BM'
        ? `Bil naik RM${round2(totalBillChange)} tetapi disebabkan AFA (kerajaan) — bukan tabiat anda. Tabiat anda sebenarnya bertambah baik.`
        : `Bill up RM${round2(totalBillChange)} but caused by AFA (government) — not your behaviour. Your behaviour actually improved.`;
    } else if (behaviourChange > 0 && afaChange > 0) {
      // Both AFA and behaviour caused increase
      const behaviourPercent = Math.round((behaviourChange / totalBillChange) * 100);
      if (behaviourPercent <= 50) {
        factor5 = 5;
        factor5Detail = lang === 'BM'
          ? `Bil naik RM${round2(totalBillChange)}. AFA menyumbang ${100 - behaviourPercent}%, tabiat anda ${behaviourPercent}%.`
          : `Bill up RM${round2(totalBillChange)}. AFA contributed ${100 - behaviourPercent}%, your behaviour ${behaviourPercent}%.`;
      } else {
        factor5 = 2;
        factor5Detail = lang === 'BM'
          ? `Bil naik RM${round2(totalBillChange)}. Kebanyakan disebabkan tabiat anda (${behaviourPercent}%). Perlu tindakan.`
          : `Bill up RM${round2(totalBillChange)}. Mostly your behaviour (${behaviourPercent}%). Action needed.`;
      }
    } else {
      // Bill went up due to behaviour
      factor5 = 0;
      factor5Detail = lang === 'BM'
        ? `Bil naik RM${round2(totalBillChange)} disebabkan penggunaan bertambah. Semak misi JIMAT anda.`
        : `Bill up RM${round2(totalBillChange)} due to increased usage. Review your JIMAT missions.`;
    }
  } else {
    // First report
    factor5 = 5;
    factor5Detail = lang === 'BM'
      ? 'Laporan pertama — tiada perbandingan bulan lepas.'
      : 'First report — no previous month to compare.';
  }

  // ── TOTAL SCORE ───────────────────────────────────────
  const totalScore = factor1 + factor2 + factor3 + factor4 + factor5;

  // ── HEALTH BAND ───────────────────────────────────────
  let band = '';
  let bandLabel = '';
  let bandMessage = '';
  let bandEmoji = '';

  if (totalScore >= 90) {
    band = 'EXCELLENT';
    bandEmoji = '🟢';
    bandLabel = lang === 'BM' ? 'CEMERLANG' : 'EXCELLENT';
    bandMessage = lang === 'BM'
      ? 'Penggunaan elektrik anda sangat cekap. Teruskan tabiat baik ini!'
      : 'Your electricity usage is very efficient. Keep up the great habits!';
  } else if (totalScore >= 75) {
    band = 'GOOD';
    bandEmoji = '🟡';
    bandLabel = lang === 'BM' ? 'BAIK' : 'GOOD';
    bandMessage = lang === 'BM'
      ? 'Penggunaan anda baik. Ikut misi JIMAT untuk capai tahap cemerlang.'
      : 'Your usage is good. Follow JIMAT missions to reach excellent.';
  } else if (totalScore >= 60) {
    band = 'FAIR';
    bandEmoji = '🟠';
    bandLabel = lang === 'BM' ? 'SEDERHANA' : 'FAIR';
    bandMessage = lang === 'BM'
      ? 'Ada ruang penambahbaikan. Fokus pada misi JIMAT bulan ini.'
      : 'Room for improvement. Focus on JIMAT missions this month.';
  } else if (totalScore >= 40) {
    band = 'ATTENTION';
    bandEmoji = '🔴';
    bandLabel = lang === 'BM' ? 'PERLU PERHATIAN' : 'NEEDS ATTENTION';
    bandMessage = lang === 'BM'
      ? 'Penggunaan anda membimbangkan. Laksanakan semua misi JIMAT segera.'
      : 'Your usage is concerning. Implement all JIMAT missions immediately.';
  } else {
    band = 'CRITICAL';
    bandEmoji = '⚫';
    bandLabel = lang === 'BM' ? 'KRITIKAL' : 'CRITICAL';
    bandMessage = lang === 'BM'
      ? 'Anda sedang membazir dengan teruk. Tindakan segera diperlukan!'
      : 'You are wasting badly. Immediate action required!';
  }

  return {
    // Overall
    score: totalScore,
    band,
    bandLabel,
    bandEmoji,
    bandMessage,

    // Factor breakdown
    factors: {
      threshold: {
        score: factor1,
        maxScore: 25,
        detail: factor1Detail,
        label: lang === 'BM' ? 'Had 600 kWh' : '600 kWh Threshold'
      },
      trend: {
        score: factor2,
        maxScore: 25,
        detail: factor2Detail,
        label: lang === 'BM' ? 'Trend Bulanan' : 'Monthly Trend',
        kwhChange: round2(kwhChange),
        kwhChangePercent
      },
      bleeder: {
        score: factor3,
        maxScore: 25,
        detail: factor3Detail,
        label: lang === 'BM' ? 'Tumpuan Pembazir' : 'Bleeder Concentration'
      },
      afa: {
        score: factor4,
        maxScore: 15,
        detail: factor4Detail,
        label: lang === 'BM' ? 'Pendedahan AFA' : 'AFA Exposure'
      },
      cause: {
        score: factor5,
        maxScore: 10,
        detail: factor5Detail,
        label: lang === 'BM' ? 'Punca Perubahan Bil' : 'Bill Change Cause'
      }
    },

    // What to focus on (lowest scoring factors)
    focusAreas: [
      { factor: 'threshold', score: factor1, max: 25 },
      { factor: 'trend', score: factor2, max: 25 },
      { factor: 'bleeder', score: factor3, max: 25 },
      { factor: 'afa', score: factor4, max: 15 },
      { factor: 'cause', score: factor5, max: 10 }
    ]
      .sort((a, b) => (a.score / a.max) - (b.score / b.max))
      .slice(0, 2)
      .map(f => f.factor)
  };
};

// ── CALCULATE MISSION KWH TARGET ─────────────────────────
// What kWh should user target next month?
// Based on current usage + threshold proximity
const calculateMissionTarget = (currentKwh) => {
  if (currentKwh > 600) {
    // Target = get below 600 kWh
    // Or reduce by 10% if far above 600
    const thresholdTarget = 595; // Just below 600
    const tenPercentTarget = Math.round(currentKwh * 0.90);
    // Use whichever is more achievable (higher number)
    return Math.max(thresholdTarget, tenPercentTarget);
  } else {
    // Already below 600 — target 5% further reduction
    return Math.round(currentKwh * 0.95);
  }
};

module.exports = {
  calculateHealthScore,
  calculateMissionTarget
};