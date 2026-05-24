const admin = require('../firebaseAdmin');
const { sendWhatsAppMessage } = require('./whatsapp');

// In-memory dedup — prevents double-send within a single server session
const notifiedThisSession = new Set();

function fmt(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}

async function getTraderPhone(userId) {
  try {
    const user = await admin.auth().getUser(userId);
    return user.phoneNumber || null; // e.g. +2348012345678
  } catch {
    return null;
  }
}

async function sendDecisionWhatsApp(appId, data) {
  const { userId, status, amount, businessName, rejectionReason } = data;

  const phone = await getTraderPhone(userId);
  if (!phone) {
    console.warn(`[loanNotifier] No phone for userId ${userId}, skipping WhatsApp`);
    return;
  }

  const name = businessName || 'Trader';
  let message;

  if (status === 'approved') {
    message = [
      `🎉 Congratulations ${name}!`,
      ``,
      `Your TRADR loan application for ${fmt(amount)} has been APPROVED.`,
      ``,
      `Our team will contact you within 24 hours to complete disbursement.`,
      ``,
      `Keep recording on TRADR 💪`,
      ``,
      `— TRADR Loans`,
    ].join('\n');
  } else {
    message = [
      `Hello ${name},`,
      ``,
      `We reviewed your TRADR loan application for ${fmt(amount)}.`,
      ``,
      `Unfortunately, we're unable to approve it at this time.`,
      rejectionReason ? `\nReason: ${rejectionReason}\n` : ``,
      `Keep recording your sales every day. A stronger TRADR Score in 30 days puts you in a much better position.`,
      ``,
      `Open TRADR → Loan Status to see next steps.`,
      ``,
      `— TRADR Loans`,
    ].filter(l => l !== undefined).join('\n');
  }

  await sendWhatsAppMessage(phone, message);
}

async function processDecision(appId, data) {
  if (notifiedThisSession.has(appId)) return;
  if (data.decisionNotifiedAt) return; // already notified in a prior server session

  notifiedThisSession.add(appId);

  try {
    await sendDecisionWhatsApp(appId, data);

    const db = admin.firestore();
    await db.collection('loanApplications').doc(appId).update({
      decisionNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[loanNotifier] Sent ${data.status} notification → ${appId}`);
  } catch (err) {
    notifiedThisSession.delete(appId); // allow retry on next change
    console.error(`[loanNotifier] Failed to notify ${appId}:`, err.message);
  }
}

// When the server starts and when status changes to approved/rejected, this fires.
// Documents that were already notified have decisionNotifiedAt set and are skipped.
function startLoanDecisionListener() {
  if (!admin.apps.length) {
    console.warn('[loanNotifier] Firebase Admin not ready, skipping listener');
    return;
  }

  const db = admin.firestore();

  db.collection('loanApplications')
    .where('status', 'in', ['approved', 'rejected'])
    .onSnapshot(
      snapshot => {
        snapshot.docChanges().forEach(change => {
          // 'added' fires when a doc enters the query scope (status just changed to approved/rejected)
          // 'modified' fires when an already-decided doc is updated (e.g. rejectionReason added)
          if (change.type === 'removed') return;
          processDecision(change.doc.id, change.doc.data());
        });
      },
      err => {
        console.error('[loanNotifier] Snapshot listener error:', err.message);
      }
    );

  console.log('[loanNotifier] Loan decision listener active');
}

// Manual trigger — call this from /mfb/loan-decision if the server was sleeping
// and missed the automatic notification
async function notifyLoanDecision(appId) {
  if (!admin.apps.length) throw new Error('Firebase Admin not ready');

  const db = admin.firestore();
  const snap = await db.collection('loanApplications').doc(appId).get();
  if (!snap.exists) throw new Error(`Application ${appId} not found`);

  const data = snap.data();
  if (data.status !== 'approved' && data.status !== 'rejected') {
    throw new Error(`Application status is "${data.status}", not a final decision`);
  }

  // Force re-notify even if already sent (manual trigger = intentional resend)
  notifiedThisSession.delete(appId);
  const dataWithoutFlag = { ...data, decisionNotifiedAt: null };
  await sendDecisionWhatsApp(appId, dataWithoutFlag);

  await db.collection('loanApplications').doc(appId).update({
    decisionNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { sent: true, status: data.status };
}

module.exports = { startLoanDecisionListener, notifyLoanDecision };
