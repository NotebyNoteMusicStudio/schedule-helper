-- ─────────────────────────────────────────────────────────────
-- Schedule Helper — Supabase Database Setup
-- Run this in: supabase.com → your project → SQL Editor
-- ─────────────────────────────────────────────────────────────

-- 1. Profiles table (extends Supabase auth.users)
create table if not exists public.profiles (
  id                    uuid references auth.users on delete cascade primary key,
  email                 text,
  stripe_customer_id    text unique,
  stripe_subscription_id text unique,
  subscription_status   text default 'incomplete',
  -- Status values: incomplete | trialing | active | past_due | canceled | unpaid
  full_name             text,
  ghl_contact_id        text,
  access_granted_at     timestamptz,
  last_login_at         timestamptz,
  business_type         text,  -- 'mobile' | 'location' | 'solo'
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- 2. Row Level Security — users can only read/write their own row
alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Service role (used by API functions) bypasses RLS automatically

-- 3. Auto-create profile row when a new user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 4. Auto-update updated_at timestamp
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- Done. You should see the profiles table in your Table Editor.
-- ─────────────────────────────────────────────────────────────
