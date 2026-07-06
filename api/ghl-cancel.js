// api/ghl-cancel.js
// Receives a webhook from GHL when a subscription is cancelled.
// Full-version behavior:
//   - If GHL sends a paid-through / period-end date, the user KEEPS access until that date
//     (grace period). subscription_status flips to 'cancelling', access_until = that date.
//   - When access_until passes, the app's access check cuts them off automatically — no action needed.
//   - If NO date is given (or it's already past), access is revoked immediately + sessions killed.
//
// ── GHL Setup ──────────────────────────────────────────────────────────────────
// Trigger: Subscription/Order Cancelled
// Action: Webhook → POST https://www.theschedulehelper.com/api/ghl-cancel
// Header:  x-ghl-secret: <same secret as ghl-webhook.js>
// Payload: {
//   "email": "{{contact.email}}",
//   "contact_id": "{{contact.id}}",
//   "access_until": "{{subscription.current_period_end}}"   // paid-through date; ISO or yyyy-mm-dd
// }
// (If your GHL merge field for period end differs, map it to access_until.)
// ───────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-ghl-secret'];
  if (secret !== process.env.GHL_WEBHOOK_SECRET) {
    console.error('Invalid GHL cancel webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { email, contact_id, access_until, billing_day } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // Find the user via the profiles table (indexed lookup — scales to any user count;
    // auth.admin.listUsers() is paginated at 50 and silently misses users beyond page 1).
    const { data: profileRow, error: findError } = await supabase
      .from('profiles')
      .select('id, email')
      .ilike('email', email)
      .maybeSingle();
    if (findError) throw findError;
    if (!profileRow) {
      console.warn('Cancel webhook: no user found for', email);
      return res.json({ success: true, message: 'No account found — nothing to revoke' });
    }
    const user = { id: profileRow.id, email: profileRow.email };

    // Determine the paid-through date.
    // Preferred input: billing_day (1–31) — the day of the month they normally bill.
    // We resolve it to the NEXT occurrence of that day from today, so access ends on
    // their next billing date (honoring time already paid). An explicit access_until
    // date is still supported as a fallback if one is ever sent.
    const now = new Date();
    let untilDate = null;

    const dayNum = parseInt(billing_day, 10);
    if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
      untilDate = nextBillingDate(now, dayNum);
    } else if (access_until) {
      const d = new Date(access_until);
      if (!isNaN(d.getTime())) untilDate = d;
    }

    const hasFutureAccess = untilDate && untilDate > now;

    if (hasFutureAccess) {
      // ── Grace period: keep access until the paid period ends ──
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          subscription_status: 'cancelling',       // cancelled, but still inside paid period
          access_until: untilDate.toISOString(),
          cancelled_at: now.toISOString()
        })
        .eq('id', user.id);
      if (updateError) throw updateError;

      console.log(`Cancellation scheduled for ${email} — access until ${untilDate.toISOString()}`);
      return res.json({
        success: true,
        mode: 'grace',
        message: `Access retained until ${untilDate.toISOString()}`,
        accessUntil: untilDate.toISOString(),
        userId: user.id
      });
    }

    // ── No future date (or already expired): revoke access immediately ──
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_status: 'inactive',
        access_until: null,
        cancelled_at: now.toISOString()
      })
      .eq('id', user.id);
    if (updateError) throw updateError;

    // Force-sign-out all sessions (immediate cutoff)
    const { error: signOutError } = await supabase.auth.admin.signOut(user.id, 'others');
    if (signOutError) console.error('Sign out error (non-fatal):', signOutError.message);

    console.log(`Access revoked immediately for ${email} (${user.id})`);
    return res.json({
      success: true,
      mode: 'immediate',
      message: `Access revoked for ${email}`,
      userId: user.id
    });

  } catch (err) {
    console.error('Cancel webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Given "today" and a billing day-of-month (1–31), return the NEXT date on which
// that day occurs (today counts as already-passed, so it rolls to next month).
// Handles short months: e.g. billing day 31 in a 30-day month → the 30th; Feb → 28/29.
// Computed entirely in UTC to avoid timezone drift in the comparison.
function nextBillingDate(today, day) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-based

  const clampToMonth = (year, month, d) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); // last day of that month
    const useDay = Math.min(d, lastDay);
    // End of that day (UTC) so access lasts through the whole billing day.
    return new Date(Date.UTC(year, month, useDay, 23, 59, 59, 999));
  };

  // Candidate in the current month
  let candidate = clampToMonth(y, m, day);
  // If that day is today or already passed, roll to next month. Comparing by date
  // (not time) so that cancelling ON the billing day rolls forward a full cycle
  // rather than ending access the same day.
  const todayDateOnly = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const candDateOnly = Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate());
  if (candDateOnly <= todayDateOnly) {
    const nm = m + 1;
    const ny = y + Math.floor(nm / 12);
    candidate = clampToMonth(ny, nm % 12, day);
  }
  return candidate;
}
