// api/subscription-status.js
// Checks if user has active access (granted via GHL purchase webhook)

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
    .select('subscription_status, access_granted_at, ghl_contact_id')
    .eq('id', user.id)
    .single();

  if (!profile) return res.json({ active: false, reason: 'No profile found' });

  const active = profile.subscription_status === 'active';
  return res.json({
    active,
    status: profile.subscription_status,
    accessGrantedAt: profile.access_granted_at,
    hasGHLContact: !!profile.ghl_contact_id,
    businessType: profile.business_type || null
  });
};
