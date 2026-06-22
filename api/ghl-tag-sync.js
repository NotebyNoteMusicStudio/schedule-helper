// api/ghl-tag-sync.js
// Called from the app after successful login.
// Updates GHL contact tags to reflect active status.
//
// ── How it's called ──────────────────────────────────────────────────────────
// Frontend calls: POST /api/ghl-tag-sync with Bearer token (Supabase session)
// Automatically fires on first login and periodically to keep tags in sync.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify user session
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid session' });

  // Get their GHL contact ID from profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('ghl_contact_id, subscription_status, last_login_at')
    .eq('id', user.id)
    .single();

  if (!profile?.ghl_contact_id || !process.env.GHL_API_KEY) {
    return res.json({ synced: false, reason: 'No GHL contact ID or API key' });
  }

  // Update last login time
  await supabase.from('profiles').update({
    last_login_at: new Date().toISOString()
  }).eq('id', user.id);

  try {
    const headers = {
      'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    };

    // Remove pending-setup tag, add active tag
    const tagsToAdd = ['schedule-helper-active'];
    const tagsToRemove = ['schedule-helper-pending-setup'];

    // Add active tag
    await fetch(`https://services.leadconnectorhq.com/contacts/${profile.ghl_contact_id}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: tagsToAdd })
    });

    // Remove pending tag
    await fetch(`https://services.leadconnectorhq.com/contacts/${profile.ghl_contact_id}/tags`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ tags: tagsToRemove })
    });

    return res.json({ synced: true, tags: tagsToAdd });

  } catch (err) {
    console.error('GHL tag sync error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
