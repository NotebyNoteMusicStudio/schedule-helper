// api/validate-coupon.js
// Validates a Stripe coupon code and returns discount info

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false });

  try {
    // Try as promotion code first (e.g. "WELCOME50")
    const promoCodes = await stripe.promotionCodes.list({ code, active: true, limit: 1 });

    if (promoCodes.data.length > 0) {
      const promo = promoCodes.data[0];
      const coupon = promo.coupon;
      return res.json({
        valid: true,
        couponId: coupon.id,
        description: formatDiscount(coupon),
        newPrice: calcNewPrice(coupon)
      });
    }

    // Try as direct coupon ID
    const coupon = await stripe.coupons.retrieve(code);
    if (coupon.valid) {
      return res.json({
        valid: true,
        couponId: coupon.id,
        description: formatDiscount(coupon),
        newPrice: calcNewPrice(coupon)
      });
    }

    return res.json({ valid: false });
  } catch {
    return res.json({ valid: false });
  }
};

function formatDiscount(coupon) {
  if (coupon.percent_off) return `${coupon.percent_off}% off`;
  if (coupon.amount_off) return `$${(coupon.amount_off / 100).toFixed(0)} off`;
  if (coupon.duration === 'forever') return 'Discount applied forever';
  return 'Discount applied';
}

function calcNewPrice(coupon) {
  const base = 49;
  if (coupon.percent_off) {
    const discounted = base * (1 - coupon.percent_off / 100);
    return `$${discounted.toFixed(0)} / month`;
  }
  if (coupon.amount_off) {
    const discounted = base - coupon.amount_off / 100;
    return `$${Math.max(0, discounted).toFixed(0)} / month`;
  }
  return null;
}
