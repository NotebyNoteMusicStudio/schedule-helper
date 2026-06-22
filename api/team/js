// api/team.js
// Returns team members for the current user's org
// Also handles updating member permissions and removing members

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  // GET — list team members
  if (req.method === 'GET') {
    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .eq('owner_id', user.id)
      .single();

    if (!org) return res.json({ members: [] });

    const { data: members } = await supabase
      .from('org_members')
      .select('id, email, role, can_delete, can_reset, status, invited_at, joined_at')
      .eq('org_id', org.id)
      .order('invited_at', { ascending: false });

    return res.json({ members: members || [] });
  }

  // PATCH — update member permissions
  if (req.method === 'PATCH') {
    const { member_id, can_delete, can_reset } = req.body;
    
    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .eq('owner_id', user.id)
      .single();

    if (!org) return res.status(403).json({ error: 'Not authorized' });

    await supabase
      .from('org_members')
      .update({ can_delete, can_reset })
      .eq('id', member_id)
      .eq('org_id', org.id);

    return res.json({ success: true });
  }

  // DELETE — remove a team member
  if (req.method === 'DELETE') {
    const { member_id } = req.body;

    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .eq('owner_id', user.id)
      .single();

    if (!org) return res.status(403).json({ error: 'Not authorized' });

    await supabase
      .from('org_members')
      .delete()
      .eq('id', member_id)
      .eq('org_id', org.id);

    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
