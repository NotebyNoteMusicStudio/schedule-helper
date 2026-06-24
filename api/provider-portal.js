// api/provider-portal.js
// Public, token-authenticated endpoint for the provider self-service portal.
// The "token" is the provider's id (a random UUID already used in the share link),
// so teachers do NOT need a login to enter their own availability.
//
//   GET  ?token=<providerId>
//        -> provider name + studio worker label + current availability/appointments
//   POST { token, availability:[{day,from,to}], students:[{day,time,address,name}] }
//        -> replaces that provider's availability + appointments
//
// Runs with the service role key, so it bypasses row-level security. It only ever
// touches the single provider named by the token and derives the studio owner from
// that provider row, so a link holder can never reach another studio's data.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const MAX_ROWS = 200; // sanity cap per list

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Load this provider's current schedule ──────────────────────────────
    if (req.method === 'GET') {
      const token = req.query.token;
      if (!isUuid(token)) return res.status(400).json({ error: 'Invalid link' });

      const { data: provider, error: pErr } = await supabase
        .from('providers')
        .select('id, user_id, first, last')
        .eq('id', token)
        .single();
      if (pErr || !provider) return res.status(404).json({ error: 'Link not found' });

      const [availRes, apptRes, settingsRes] = await Promise.all([
        supabase.from('availability').select('day, from_time, to_time').eq('provider_id', provider.id),
        supabase.from('appointments').select('day, time, address, name').eq('provider_id', provider.id),
        supabase.from('user_settings').select('worker_label, biz_name').eq('user_id', provider.user_id).maybeSingle()
      ]);

      return res.json({
        provider: { first: provider.first || '', last: provider.last || '' },
        worker_label: settingsRes.data?.worker_label || 'Providers',
        biz_name: settingsRes.data?.biz_name || '',
        availability: (availRes.data || []).map(a => ({ day: a.day, from: a.from_time, to: a.to_time })),
        students: (apptRes.data || []).map(s => ({ day: s.day, time: s.time, address: s.address || '', name: s.name || '' }))
      });
    }

    // ── Save this provider's schedule (replace, like the in-app flow) ──────
    if (req.method === 'POST') {
      const { token, availability, students } = req.body || {};
      if (!isUuid(token)) return res.status(400).json({ error: 'Invalid link' });
      if (!Array.isArray(availability) || !Array.isArray(students)) {
        return res.status(400).json({ error: 'Bad payload' });
      }
      if (availability.length > MAX_ROWS || students.length > MAX_ROWS) {
        return res.status(400).json({ error: 'Too many entries' });
      }

      const { data: provider, error: pErr } = await supabase
        .from('providers')
        .select('id, user_id')
        .eq('id', token)
        .single();
      if (pErr || !provider) return res.status(404).json({ error: 'Link not found' });

      const ownerId = provider.user_id;

      // Replace availability
      await supabase.from('availability').delete().eq('provider_id', provider.id);
      const availRows = availability
        .filter(a => a && a.day && a.from && a.to)
        .map(a => ({
          user_id: ownerId,
          provider_id: provider.id,
          day: String(a.day),
          from_time: String(a.from),
          to_time: String(a.to)
        }));
      if (availRows.length) {
        const { error } = await supabase.from('availability').insert(availRows);
        if (error) return res.status(500).json({ error: error.message });
      }

      // Replace appointments
      await supabase.from('appointments').delete().eq('provider_id', provider.id);
      const apptRows = students
        .filter(s => s && (s.address || s.name))
        .map(s => ({
          user_id: ownerId,
          provider_id: provider.id,
          day: String(s.day || ''),
          time: String(s.time || ''),
          address: String(s.address || ''),
          name: String(s.name || '')
        }));
      if (apptRows.length) {
        const { error } = await supabase.from('appointments').insert(apptRows);
        if (error) return res.status(500).json({ error: error.message });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('provider-portal error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
