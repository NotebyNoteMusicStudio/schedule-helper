// api/create-subscription.js
// Creates a Stripe customer + subscription with 7-day trial

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role key — server only, never expose to client
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Supabase session
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { paymentMethodId, coupon } = req.body;
  if (!paymentMethodId) return res.status(400).json({ error: 'Payment method required' });

  try {
    // 1. Create or retrieve Stripe customer
    let customerId;
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profile?.stripe_customer_id) {
      customerId = profile.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id }
      });
      customerId = customer.id;

      // Save customer ID to Supabase
      await supabase.from('profiles').upsert({
        id: user.id,
        email: user.email,
        stripe_customer_id: customerId
      });
    }

    // 2. Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    // 3. Build subscription params
    const subParams = {
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      trial_period_days: 7,
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription'
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: { supabase_user_id: user.id }
    };

    // 4. Apply coupon if provided
    if (coupon) {
      subParams.coupon = coupon;
    }

    // 5. Create subscription
    const subscription = await stripe.subscriptions.create(subParams);

    // 6. Handle 3D Secure requirement
    const invoice = subscription.latest_invoice;
    const paymentIntent = invoice?.payment_intent;
    if (paymentIntent?.status === 'requires_action') {
      return res.json({
        requiresAction: true,
        clientSecret: paymentIntent.client_secret
      });
    }

    // 7. Save subscription to Supabase
    await supabase.from('profiles').update({
      stripe_subscription_id: subscription.id,
      subscription_status: subscription.status,  // 'trialing'
      trial_ends_at: new Date(subscription.trial_end * 1000).toISOString()
    }).eq('id', user.id);

    res.json({ success: true, status: subscription.status });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
