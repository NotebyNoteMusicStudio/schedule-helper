# Schedule Helper — Deployment Guide

## How it works
1. Client purchases through your **GHL funnel** (you handle all billing there)
2. GHL fires a webhook → Vercel creates their Supabase account
3. GHL sends them a "Set your password" email with their magic link
4. They click → set password → inside the app
5. On login, app pings GHL to update their tags to `schedule-helper-active`

---

## Step 1 — Supabase (5 minutes)

1. Go to **supabase.com** → New project → name it "schedule-helper"
2. **SQL Editor** → paste `supabase-setup.sql` → Run
3. **Settings → API** → copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` ⚠️ server only
4. **Auth → Settings** → turn off "Enable email confirmations" (GHL handles emails)
5. **Auth → Settings** → turn off "Allow new users to sign up" (invite only via GHL)

---

## Step 2 — Go High Level (10 minutes)

### A. Get your GHL API Key
Settings → Integrations → API Keys → copy → `GHL_API_KEY`

### B. Create a Custom Field for the setup link
Settings → Custom Fields → Add Field:
- Name: `Schedule Helper Setup Link`
- Type: Text
- Copy the Field ID → `GHL_SETUP_LINK_FIELD_ID`

### C. Add business type field to your order form
GHL → Settings → Custom Fields → Add Field:
- Name: `Schedule Helper Mode`
- Type: Radio / Dropdown
- Options:
  - `mobile` — 🚗 Mobile / I travel to clients
  - `location` — 📍 Fixed location / Clients come to me
  - `solo` — 👤 Solo operator / I manage my own schedule

Add this field to your order form so clients select it at checkout.

### D. Build the purchase automation
Automations → New Workflow:
- **Trigger:** Order Form Submitted (your Schedule Helper product)
- **Action 1:** Webhook → POST → `https://your-domain.com/api/ghl-webhook`
  - Header: `x-ghl-secret` → your secret string (same as `GHL_WEBHOOK_SECRET`)
  - Body (JSON):
    ```json
    {
      "email": "{{contact.email}}",
      "name": "{{contact.full_name}}",
      "contact_id": "{{contact.id}}",
      "business_type": "{{contact.schedule_helper_mode}}"
    }
    ```
- **Action 2:** Send Email → "Set up your Schedule Helper account"
  - Body includes: `{{contact.schedule_helper_setup_link}}`
  - The webhook populates this field automatically

### D. Build the "Set Password" email in GHL
Subject: `Your Schedule Helper account is ready`
Body:
```
Hi {{contact.first_name}},

Your Schedule Helper account has been created. Click below to set your password and get started.

[Set My Password] → {{contact.schedule_helper_setup_link}}

This link expires in 24 hours.
```

---

## Step 3 — Google Maps (5 minutes)

1. **console.cloud.google.com** → New project → Enable Distance Matrix API
2. APIs & Services → Credentials → Create API Key → restrict to Distance Matrix API
3. Copy key → `GOOGLE_MAPS_API_KEY`

---

## Step 4 — Deploy to Vercel (5 minutes)

1. Push this folder to GitHub
2. **vercel.com** → New Project → import repo
3. Settings → Environment Variables → add all from `.env.example`
4. Deploy → you get a `.vercel.app` URL immediately
5. Settings → Domains → add your custom domain

---

## GHL Tags (automatic)

| Tag | When it's applied |
|-----|-------------------|
| `schedule-helper-purchased` | On purchase (webhook fires) |
| `schedule-helper-pending-setup` | Until they set their password and log in |
| `schedule-helper-active` | After first login |
| `schedule-helper-mode-mobile` | If they selected mobile at checkout |
| `schedule-helper-mode-location` | If they selected fixed location at checkout |
| `schedule-helper-mode-solo` | If they selected solo operator at checkout |

**Thank you page:** Use GHL conditional content to show the right walkthrough video based on which mode tag was applied at purchase. Three sections, each hidden unless the matching tag is present.

Use these tags to trigger follow-up automations in GHL:
- No login after 48hrs → send reminder
- Active → move to nurture sequence
- etc.

---

## Files in this project

| File | Purpose |
|------|---------|
| `public/login.html` | Sign in, forgot password, set password |
| `public/app.html` | The Schedule Helper app |
| `api/ghl-webhook.js` | Receives GHL purchase event, creates Supabase account |
| `api/ghl-tag-sync.js` | Updates GHL tags when client logs in |
| `api/subscription-status.js` | Checks if user has access |
| `api/distance.js` | Google Maps proxy |
| `supabase-setup.sql` | Database schema — run once |
| `.env.example` | All required environment variables |
