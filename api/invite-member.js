// api/invite-member.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { email, can_delete, can_reset } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    let { data: org } = await supabase.from('organizations').select('id').eq('owner_id', user.id).single();
    if (!org) {
      const { data: newOrg, error: orgError } = await supabase
        .from('organizations')
        .insert({ owner_id: user.id })
        .select('id')
        .single();
      if (orgError) return res.status(500).json({ error: 'Could not create org: ' + orgError.message });
      org = newOrg;
    }
    const { data: existing } = await supabase.from('org_members').select('id').eq('org_id', org.id).eq('email', email).single();
    if (existing) return res.status(400).json({ error: 'This person is already a team member.' });

    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email === email);

    let memberId;
    if (existingUser) {
      memberId = existingUser.id;
    } else {
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({ email, email_confirm: true, user_metadata: { role: 'member' } });
      if (createError) return res.status(500).json({ error: createError.message });
      memberId = newUser.user.id;
    }

    await supabase.from('org_members').insert({ org_id: org.id, user_id: memberId, email, role: 'member', can_delete: can_delete || false, can_reset: can_reset || false, status: 'pending' });
    await supabase.from('profiles').upsert({ id: memberId, email, org_id: org.id, role: 'member', subscription_status: 'active' });

    const { data: linkData } = await supabase.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/` } });
    const setupLink = linkData?.properties?.action_link;

    return res.json({ success: true, setupLink, message: `Invitation sent to ${email}` });
  } catch (err) {
    console.error('Invite error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
