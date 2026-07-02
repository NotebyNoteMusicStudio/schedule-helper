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

    if (alreadyExists) {
      // Already has an account — just update their profile and re-send invite
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
      // ── 2. Create new Supabase user ──
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,  // skip email confirmation — GHL handles the welcome email
        user_metadata: {
          full_name: name || '',
          ghl_contact_id: contact_id || ''
        }
      });

      if (createError) {
        // Rare edge: auth user exists but has no profile row (e.g. pre-profiles account).
        // Fall back to a paginated scan of auth users to recover their id.
        if (/already|registered|exists/i.test(createError.message)) {
          let found = null, page = 1;
          while (!found) {
            const { data: pageData, error: pageErr } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
            if (pageErr || !pageData?.users?.length) break;
            found = pageData.users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
            if (pageData.users.length < 1000) break;
            page++;
          }
          if (!found) {
            console.error('Create user error (and fallback scan failed):', createError.message);
            return res.status(500).json({ error: createError.message });
          }
          userId = found.id;
        } else {
          console.error('Create user error:', createError.message);
          return res.status(500).json({ error: createError.message });
        }
      } else {
        userId = newUser.user.id;
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

    // ── 4. Generate password setup link ──
    // This is the link you put in your GHL email template as {{custom_value.setup_link}}
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',   // 'recovery' type works for first-time password setup too
      email,
      options: {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/`
      }
    });

    if (linkError) {
      console.error('Link generation error:', linkError.message);
      return res.status(500).json({ error: linkError.message });
    }

    const setupLink = linkData.properties.action_link;

    // ── 5. Push setup link + tag back to GHL via API ──
    if (contact_id && process.env.GHL_API_KEY) {
      await updateGHLContact(contact_id, setupLink);
    }

    // ── 6. Return success + setup link ──
    // GHL can use this in the webhook response or you can trigger a GHL email action
    return res.json({
      success: true,
      userId,
      email,
      setupLink,  // put this in your GHL email: {{custom_value.setup_link}}
      message: alreadyExists ? 'Existing user — access renewed' : 'New user created'
    });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Update GHL contact with setup link and tag ──────────────────────────────
async function updateGHLContact(contactId, setupLink) {
  try {
    const headers = {
      'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    };

    // Add custom field with the setup link so GHL email can use it
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        customFields: [
          {
            id: process.env.GHL_SETUP_LINK_FIELD_ID || 'schedule_helper_setup_link',
            value: setupLink
          }
        ],
        tags: [
          'schedule-helper-purchased',
          'schedule-helper-pending-setup',
          business_type ? `schedule-helper-mode-${business_type}` : null
        ].filter(Boolean)
      })
    });

  } catch (err) {
    // Non-fatal — log but don't fail the webhook
    console.error('GHL update error:', err.message);
  }
}
