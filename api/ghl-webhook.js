// api/ghl-webhook.js
// Receives a webhook from Go High Level when a client purchases Schedule Helper.
// Creates their Supabase account and sends a password-setup link via GHL.
//
// ── GHL Setup ──────────────────────────────────────────────────────────────────
// In GHL: Automation → Add Trigger → "Order Form Submitted" (or Product Purchased)
// Action: Webhook → POST to https://your-domain.com/api/ghl-webhook
// Payload (Custom Values):
//   { "email": "{{contact.email}}", "name": "{{contact.full_name}}", "contact_id": "{{contact.id}}" }
// Secret header: x-ghl-secret: your_webhook_secret (set in .env)
// ───────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Verify the request is from GHL ──
  const secret = req.headers['x-ghl-secret'];
  if (secret !== process.env.GHL_WEBHOOK_SECRET) {
    console.error('Invalid GHL webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { email, name, contact_id, business_type } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // ── 1. Check if user already exists ──
    // Indexed lookup on profiles — listUsers() is paginated at 50 and misses users at scale,
    // which would create duplicate accounts.
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .ilike('email', email)
      .maybeSingle();
    const alreadyExists = existingProfile ? { id: existingProfile.id } : null;

    let userId;
    let inviteSent = false;

    if (alreadyExists) {
      // Existing account — just renew their access. No email; if they need in, they use
      // "Forgot password" on the login page.
      userId = alreadyExists.id;
      await supabase.from('profiles').upsert({
        id: userId,
        email,
        full_name: name || '',
        ghl_contact_id: contact_id || '',
        subscription_status: 'active',
        business_type: business_type || null,
        access_granted_at: new Date().toISOString()
      });
    } else {
      // ── 2. New user: invite them. inviteUserByEmail BOTH creates the account AND
      //    sends the setup email through your custom SMTP (SendGrid), so it appears
      //    from you with a one-time link to set a password and log in.
      const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/`,
        data: {
          full_name: name || '',
          ghl_contact_id: contact_id || ''
        }
      });

      if (inviteError) {
        // Rare edge: an auth user already exists without a profile row. Recover the id
        // via a paginated scan and treat as existing (no invite email needed).
        if (/already|registered|exists/i.test(inviteError.message)) {
          let found = null, page = 1;
          while (!found) {
            const { data: pageData, error: pageErr } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
            if (pageErr || !pageData?.users?.length) break;
            found = pageData.users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
            if (pageData.users.length < 1000) break;
            page++;
          }
          if (!found) {
            console.error('Invite error (and fallback scan failed):', inviteError.message);
            return res.status(500).json({ error: inviteError.message });
          }
          userId = found.id;
        } else {
          console.error('Invite error:', inviteError.message);
          return res.status(500).json({ error: inviteError.message });
        }
      } else {
        userId = invited.user.id;
        inviteSent = true;
      }

      // ── 3. Save profile ──
      await supabase.from('profiles').upsert({
        id: userId,
        email,
        full_name: name || '',
        ghl_contact_id: contact_id || '',
        subscription_status: 'active',
        business_type: business_type || null,
        access_granted_at: new Date().toISOString()
      });
    }

    // ── 4. Tag the contact in GHL (pipeline/tags only — no link needed anymore) ──
    if (contact_id && process.env.GHL_API_KEY) {
      await tagGHLContact(contact_id, business_type);
    }

    // ── 5. Done ──
    return res.json({
      success: true,
      userId,
      email,
      inviteSent,
      message: alreadyExists ? 'Existing user — access renewed (no email sent)' : 'New user invited'
    });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Tag the GHL contact (pipeline/tags only) ────────────────────────────────
async function tagGHLContact(contactId, business_type) {
  try {
    const headers = {
      'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    };
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        tags: [
          'schedule-helper-purchased',
          business_type ? `schedule-helper-mode-${business_type}` : null
        ].filter(Boolean)
      })
    });
  } catch (err) {
    // Non-fatal — log but don't fail the webhook
    console.error('GHL tag error:', err.message);
  }
}
