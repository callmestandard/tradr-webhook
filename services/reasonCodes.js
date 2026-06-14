'use strict';

/**
 * Generate human-readable reason codes from a score result.
 * Returns an array of plain-English strings for credit officers.
 * Includes both positive factors and blockers.
 *
 * @param {object} scoreResult - output of computeScore(), optionally augmented with `bureau` field
 * @returns {string[]}
 */
function generateReasonCodes(scoreResult) {
  const {
    daysWithActivity,
    totalDaysRecording,
    thisMonthSales,
    lastMonthSales,
    digitalPaymentRatio,
    expenseRatio,
    activeWeeks,
    bvnVerified,
    bureau,
    dataQualityRatio,
    dataQualityBand,
  } = scoreResult;

  const codes = [];

  // Recording consistency
  if (daysWithActivity >= 20) {
    codes.push(`Recorded sales ${daysWithActivity} of last 30 days — strong consistency`);
  } else if (daysWithActivity >= 10) {
    codes.push(`Recorded sales ${daysWithActivity} of last 30 days`);
  } else {
    codes.push(`Only recorded sales on ${daysWithActivity} of last 30 days — low consistency`);
  }

  // Trading history depth
  if (totalDaysRecording >= 90) {
    codes.push(`${totalDaysRecording} days of trading history on record`);
  } else if (totalDaysRecording >= 60) {
    codes.push(`${totalDaysRecording} days of history — meets 60-day minimum`);
  } else {
    codes.push(`Only ${totalDaysRecording} days of history — minimum is 60 for loan eligibility`);
  }

  // Revenue
  const bestMonthly = Math.max(thisMonthSales || 0, lastMonthSales || 0);
  if (bestMonthly >= 150000) {
    codes.push('Monthly revenue above ₦150,000 benchmark');
  } else if (bestMonthly >= 50000) {
    codes.push('Monthly revenue meets ₦50,000 minimum threshold');
  } else {
    codes.push('Monthly revenue below ₦50,000 minimum — more recorded sales needed');
  }

  // Income stability
  if (activeWeeks >= 6) {
    codes.push(`Active in ${activeWeeks} of last 8 weeks — stable trading pattern`);
  } else if (activeWeeks >= 4) {
    codes.push(`Active in ${activeWeeks} of last 8 weeks`);
  } else {
    codes.push(`Active in only ${activeWeeks} of last 8 weeks — irregular trading`);
  }

  // Digital payment ratio
  const digitalPct = Math.round((digitalPaymentRatio || 0) * 100);
  if (digitalPct >= 50) {
    codes.push(`${digitalPct}% of sales verified digitally (SMS / bank transfer)`);
  } else if (digitalPct >= 20) {
    codes.push(`${digitalPct}% of sales digitally verified — more bank transfers would improve score`);
  } else {
    codes.push(`Low digital verification (${digitalPct}%) — most records are manual`);
  }

  // Expense management
  if (expenseRatio !== null && expenseRatio !== undefined) {
    const pct = Math.round(expenseRatio * 100);
    if (expenseRatio <= 0.4) {
      codes.push(`Expense ratio ${pct}% of revenue — well managed`);
    } else if (expenseRatio <= 0.65) {
      codes.push(`Expense ratio ${pct}% of revenue — acceptable`);
    } else {
      codes.push(`Expense ratio ${pct}% of revenue — high relative to income`);
    }
  }

  // Data verification quality
  if (dataQualityBand != null) {
    const pct = Math.round((dataQualityRatio || 0) * 100);
    if (dataQualityBand === 'high') {
      codes.push(`${pct}% of recorded revenue verified via bank feed or payment confirmation`);
    } else if (dataQualityBand === 'medium') {
      codes.push(`${pct}% of revenue digitally verified — more bank-linked transactions would improve trust`);
    } else {
      codes.push('Most records manually entered — data verification low');
    }
  }

  // BVN
  if (bvnVerified) {
    codes.push('BVN verified');
  } else {
    codes.push('BVN not yet verified');
  }

  // Bureau
  if (bureau) {
    if (bureau.credit_check_performed) {
      codes.push('Credit bureau check on file');
      if (bureau.overdue_loans) {
        codes.push('Overdue loans flagged on bureau record');
      } else {
        codes.push('No overdue loans on bureau record');
      }
    } else {
      codes.push('No credit bureau check on file');
    }
  }

  return codes;
}

module.exports = { generateReasonCodes };
