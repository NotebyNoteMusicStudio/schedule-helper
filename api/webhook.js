// api/webhook.js
// Handles Stripe webhook events — keeps Supabase in sync with billing status

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Vercel doesn't parse raw body by default — needed for Stripe signature verification
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const sub = event.data.object;

  switch (event.type) {
    case 'customer.subscription.trial_will_end':
      // Fires 3 days before trial ends — Stripe sends reminder email automatically
      console.log(`Trial ending soon for customer ${sub.customer}`);
      break;

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Keep Supabase in sync
      const userId = sub.metadata?.supabase_user_id;
      if (userId) {
        await supabase.from('profiles').update({
          subscription_status: sub.status,
          trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null
        }).eq('id', userId);
      }
      break;
    }

    case 'invoice.payment_failed': {
      // Payment failed after trial — Stripe will retry and email the customer automatically
      const customerId = sub.customer;
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single();
      if (profile) {
        await supabase.from('profiles').update({
          subscription_status: 'past_due'
        }).eq('id', profile.id);
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const customerId = sub.customer;
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single();
      if (profile) {
        await supabase.from('profiles').update({
          subscription_status: 'active'
        }).eq('id', profile.id);
      }
      break;
    }

    default:
      // Ignore other events
      break;
  }

  res.json({ received: true });
};
