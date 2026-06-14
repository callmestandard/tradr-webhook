'use strict';

const { VERIFICATION_TIERS, inferTier } = require('./verification');

// TRADR Score — 6-component algorithm, server-side canonical implementation.
// Raw score: /100 pts  →  Public score: raw × 8.5 = /850
// This is the ONE server-side home of the algorithm. The mobile app mirrors it.
// Loan-ready: score ≥ 500 AND ≥ 60 days history AND 15+ active days/month AND ₦50k+/month revenue.

const LOAN_SCORE_THRESHOLD = 500;
const LOAN_DAYS_THRESHOLD = 60;
const LOAN_CONSISTENCY_THRESHOLD = 15; // active days in last 30
const LOAN_VOLUME_THRESHOLD = 50000;   // ₦ per month

const VERIFIED_SOURCES = new Set(['sms_auto', 'mono_auto']);

function computeDataQualityRatio(transactions) {
  const totalVolume = transactions.reduce((s, t) => s + (t.amount || 0), 0);
  if (totalVolume === 0) return { ratio: 0, band: 'low', breakdown_by_tier: {} };

  let weightedVolume = 0;
  const tierAccum = {};

  for (const tx of transactions) {
    const source = tx.verification?.source || tx.source || 'manual';
    const tier   = tx.verification?.tier   || inferTier(source);
    const weight = VERIFICATION_TIERS[tier]?.weight ?? VERIFICATION_TIERS.manual.weight;
    const amount = tx.amount || 0;
    weightedVolume += amount * weight;
    if (!tierAccum[tier]) tierAccum[tier] = { count: 0, volume: 0, weight };
    tierAccum[tier].count  += 1;
    tierAccum[tier].volume += amount;
  }

  const ratio = Math.round((weightedVolume / totalVolume) * 100) / 100;
  // Thresholds calibrated to tier weights: manual=0.6 → low, bot=0.7 → medium, bank=1.0 → high
  const band  = ratio >= 0.85 ? 'high' : ratio >= 0.65 ? 'medium' : 'low';

  const breakdown_by_tier = {};
  for (const [tier, d] of Object.entries(tierAccum)) {
    breakdown_by_tier[tier] = {
      count:  d.count,
      pct:    Math.round((d.volume / totalVolume) * 100),
      weight: d.weight,
    };
  }

  return { ratio, band, breakdown_by_tier };
}

function weightedRevenue(txList) {
  return txList.reduce((s, t) => {
    // Verified sources (SMS/bank feeds) carry full weight.
    // Manual-only records count at 70% to discourage inflation without penalising honest recording.
    const m = VERIFIED_SOURCES.has(t.source) ? 1.0 : 0.7;
    return s + t.amount * m;
  }, 0);
}

/**
 * Compute TRADR Score from a raw transaction array.
 *
 * @param {Array<{createdAt: number, type: string, amount: number, source?: string, paymentMethod?: string}>} transactions
 * @param {{ bvnVerified?: boolean }} options
 * @returns {object} Score breakdown, loan readiness flags, and component details.
 */
function computeScore(transactions, options = {}) {
  const { bvnVerified = false } = options;
  const now = Date.now();
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);

  // ── 1. Recording Consistency (30 pts) — trend bonus for improvement ──
  const last60Starts = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(todayMidnight);
    d.setDate(d.getDate() - i);
    return d.getTime();
  });
  const last30 = last60Starts.slice(0, 30);
  const prev30 = last60Starts.slice(30, 60);

  const daysWithActivity = last30.filter(ds =>
    transactions.some(t => t.createdAt >= ds && t.createdAt < ds + 86400000)
  ).length;
  const prevDaysWithActivity = prev30.filter(ds =>
    transactions.some(t => t.createdAt >= ds && t.createdAt < ds + 86400000)
  ).length;

  const baseConsistency = Math.round((daysWithActivity / 30) * 22);
  const trendBonus = daysWithActivity > prevDaysWithActivity
    ? Math.min(8, Math.round(((daysWithActivity - prevDaysWithActivity) / 30) * 8))
    : 0;
  const consistencyScore = Math.min(30, baseConsistency + trendBonus);

  // ── 2. Transaction Volume vs Benchmark (25 pts) ──
  const startOfThisMonth = new Date(todayMidnight.getFullYear(), todayMidnight.getMonth(), 1).getTime();
  const startOfLastMonth = new Date(todayMidnight.getFullYear(), todayMidnight.getMonth() - 1, 1).getTime();

  const thisMonthTx = transactions.filter(t => t.type === 'sale' && t.createdAt >= startOfThisMonth);
  const lastMonthTx = transactions.filter(
    t => t.type === 'sale' && t.createdAt >= startOfLastMonth && t.createdAt < startOfThisMonth
  );
  const thisMonthSales = thisMonthTx.reduce((s, t) => s + t.amount, 0);
  const lastMonthSales = lastMonthTx.reduce((s, t) => s + t.amount, 0);
  const thisMonthVerifiedRevenue = weightedRevenue(thisMonthTx);

  const BENCHMARK = 150000;
  const volumeScore = Math.round(Math.min(thisMonthVerifiedRevenue / BENCHMARK, 1) * 25);

  // ── 3. Business Stability / Income Variance (20 pts) — 8-week window ──
  const weeklyTotals = [];
  for (let i = 0; i < 8; i++) {
    const wStart = now - (i + 1) * 7 * 86400000;
    const wEnd = now - i * 7 * 86400000;
    weeklyTotals.push(
      transactions
        .filter(t => t.type === 'sale' && t.createdAt >= wStart && t.createdAt < wEnd)
        .reduce((s, t) => s + t.amount, 0)
    );
  }
  const activeWeeks = weeklyTotals.filter(w => w > 0).length;
  const mean = weeklyTotals.reduce((a, b) => a + b, 0) / 8;
  const variance = weeklyTotals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / 8;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  let stabilityScore = cv <= 0.2 ? 16 : cv <= 0.4 ? 12 : cv <= 0.6 ? 8 : cv <= 0.8 ? 4 : 2;
  if (activeWeeks >= 6) stabilityScore = Math.min(20, stabilityScore + 4);

  // ── 4. Digital Payment Ratio (15 pts) — 60-day window ──
  const last60Start = now - 60 * 86400000;
  const recentSales = transactions.filter(t => t.type === 'sale' && t.createdAt >= last60Start);
  const digitalSales = recentSales.filter(
    t => t.source === 'sms_auto' || t.paymentMethod === 'transfer'
  );
  const digitalPaymentRatio = recentSales.length > 0 ? digitalSales.length / recentSales.length : 0;
  const digitalScore = recentSales.length > 0 ? Math.round(digitalPaymentRatio * 15) : 5;

  // ── 5. Expense Management (5 pts) ──
  const last30Start = now - 30 * 86400000;
  const last30Revenue = transactions
    .filter(t => t.type === 'sale' && t.createdAt >= last30Start)
    .reduce((s, t) => s + t.amount, 0);
  const last30Expenses = transactions
    .filter(t => t.type === 'expense' && t.createdAt >= last30Start)
    .reduce((s, t) => s + t.amount, 0);
  const expenseRatio = last30Revenue > 0 ? last30Expenses / last30Revenue : null;
  let expenseScore = 3; // default when no revenue data
  if (last30Revenue > 0) {
    if (expenseRatio <= 0.4) expenseScore = 5;
    else if (expenseRatio <= 0.65) expenseScore = 3;
    else expenseScore = 1;
  }

  // ── 6. Profile Completeness (5 pts) ──
  const profileScore = 5;

  // ── BVN Bonus (+3 raw pts ≈ +25 on /850 scale) ──
  const bvnBonus = bvnVerified ? 3 : 0;

  const rawTotal = Math.min(
    100,
    consistencyScore + volumeScore + stabilityScore + digitalScore + expenseScore + profileScore + bvnBonus,
  );
  const total = Math.round(rawTotal * 8.5);

  // ── Loan readiness (four conditions must all pass) ──
  const firstTx = transactions.length > 0
    ? Math.min(...transactions.map(t => t.createdAt))
    : null;
  const totalDaysRecording = firstTx ? Math.floor((now - firstTx) / 86400000) : 0;

  const meetsScoreThreshold = total >= LOAN_SCORE_THRESHOLD;
  const meetsTimeThreshold = totalDaysRecording >= LOAN_DAYS_THRESHOLD;
  const meetsConsistencyThreshold = daysWithActivity >= LOAN_CONSISTENCY_THRESHOLD;
  const meetsVolumeThreshold =
    thisMonthSales >= LOAN_VOLUME_THRESHOLD || lastMonthSales >= LOAN_VOLUME_THRESHOLD;
  const isLoanReady =
    meetsScoreThreshold && meetsTimeThreshold && meetsConsistencyThreshold && meetsVolumeThreshold;

  let tier;
  if (total >= 700) tier = 'Trusted';
  else if (total >= 500) tier = 'Established';
  else if (total >= 300) tier = 'Growing';
  else tier = 'Building';

  const dqResult = computeDataQualityRatio(transactions);

  return {
    total,
    rawTotal,
    tier,
    isLoanReady,
    meetsScoreThreshold,
    meetsTimeThreshold,
    meetsConsistencyThreshold,
    meetsVolumeThreshold,
    totalDaysRecording,
    daysWithActivity,
    thisMonthSales,
    lastMonthSales,
    digitalPaymentRatio,
    expenseRatio,
    activeWeeks,
    cv,
    bvnVerified,
    dataQualityRatio:     dqResult.ratio,
    dataQualityBand:      dqResult.band,
    dataQualityBreakdown: dqResult.breakdown_by_tier,
    components: {
      recording_consistency: { score: consistencyScore, max: 30 },
      transaction_volume: { score: volumeScore, max: 25 },
      business_stability: { score: stabilityScore, max: 20 },
      digital_payment_ratio: { score: digitalScore, max: 15 },
      expense_management: { score: expenseScore, max: 5 },
      profile_completeness: { score: profileScore, max: 5 },
    },
  };
}

/**
 * Map a naira amount to a public-facing revenue band string.
 * Exact figures are never exposed to external partners.
 */
function revenueBand(naira) {
  if (naira < 50000) return '<50k';
  if (naira < 150000) return '50k-150k';
  if (naira < 300000) return '150k-300k';
  if (naira < 500000) return '300k-500k';
  return '500k+';
}

module.exports = {
  computeScore,
  computeDataQualityRatio,
  revenueBand,
  LOAN_SCORE_THRESHOLD,
  LOAN_DAYS_THRESHOLD,
  LOAN_CONSISTENCY_THRESHOLD,
  LOAN_VOLUME_THRESHOLD,
};
