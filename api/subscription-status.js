// api/subscription-status.js
// Checks if user has access. Access is granted when:
//   - subscription_status === 'active', OR
//   - they cancelled but are still inside their paid period (today < access_until)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_status, access_granted_at, access_until, ghl_contact_id, business_type')
    .eq('id', user.id)
    .single();

  if (!profile) return res.json({ active: false, reason: 'No profile found' });

  // Grace period: a cancelled user keeps access until access_until passes.
  const now = new Date();
  const withinGrace = profile.access_until && new Date(profile.access_until) > now;
  const active = profile.subscription_status === 'active' || withinGrace;

  return res.json({
    active,
    status: profile.subscription_status,
    accessGrantedAt: profile.access_granted_at,
    accessUntil: profile.access_until || null,
    inGracePeriod: !!(withinGrace && profile.subscription_status !== 'active'),
    hasGHLContact: !!profile.ghl_contact_id,
    businessType: profile.business_type || null
  });
};
