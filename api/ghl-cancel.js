// api/ghl-cancel.js
// Receives a webhook from GHL when a subscription is cancelled or payment fails.
// Immediately revokes access by setting subscription_status → inactive
// AND signs out all active sessions so they can't stay logged in.
//
// ── GHL Setup ──────────────────────────────────────────────────────────────────
// In GHL: Automation → Trigger → "Order Cancelled" / "Payment Failed"
// Action: Webhook → POST to https://www.theschedulehelper.com/api/ghl-cancel
// Payload: { "email": "{{contact.email}}", "contact_id": "{{contact.id}}" }
// Header:  x-ghl-secret: <same secret as ghl-webhook.js>
// ───────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Verify secret ──
  const secret = req.headers['x-ghl-secret'];
  if (secret !== process.env.GHL_WEBHOOK_SECRET) {
    console.error('Invalid GHL cancel webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { email, contact_id } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // ── 1. Find the Supabase user by email ──
    const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) throw listError;
    const user = users.find(u => u.email === email);
    if (!user) {
      console.warn('Cancel webhook: no user found for', email);
      return res.json({ success: true, message: 'No account found — nothing to revoke' });
    }

    // ── 2. Flip subscription_status to inactive ──
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_status: 'inactive',
        cancelled_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) throw updateError;

    // ── 3. Force-sign-out all sessions (the "force stop") ──
    // This invalidates every active token for this user immediately.
    const { error: signOutError } = await supabase.auth.admin.signOut(user.id, 'others');
    if (signOutError) console.error('Sign out error (non-fatal):', signOutError.message);

    console.log(`Cancelled access for ${email} (${user.id})`);
    return res.json({
      success: true,
      message: `Access revoked for ${email}`,
      userId: user.id
    });

  } catch (err) {
    console.error('Cancel webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
