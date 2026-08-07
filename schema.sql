-- LYKAN Miner — Database Schema (Supabase / Postgres)
-- Run this in Supabase SQL Editor once when setting up the project.

create table if not exists users (
  telegram_id      bigint primary key,
  username         text,
  first_name       text,
  coins            numeric not null default 0,
  energy           integer not null default 1000,
  max_energy       integer not null default 1000,
  tap_power        integer not null default 1,       -- coins earned per tap
  tap_level        integer not null default 1,
  mine_rate        numeric not null default 0,        -- coins earned per hour (passive)
  mine_level       integer not null default 0,
  last_energy_ts   timestamptz not null default now(),
  last_passive_ts  timestamptz not null default now(),
  referred_by      bigint references users(telegram_id),
  referral_count   integer not null default 0,
  referral_earnings numeric not null default 0,
  created_at       timestamptz not null default now()
);

create table if not exists tasks (
  id           serial primary key,
  title        text not null,
  description  text,
  reward       numeric not null default 0,
  link         text,          -- e.g. telegram channel / twitter link
  active       boolean not null default true
);

create table if not exists user_tasks (
  telegram_id  bigint references users(telegram_id),
  task_id      integer references tasks(id),
  completed_at timestamptz default now(),
  primary key (telegram_id, task_id)
);

-- Simple index to make leaderboard queries fast
create index if not exists idx_users_coins on users (coins desc);

-- Example starter tasks (edit / add your own real links)
insert into tasks (title, description, reward, link) values
  ('Join LYKAN Telegram Channel', 'Join our official channel for updates', 500, 'https://t.me/lykan_official'),
  ('Follow LYKAN on X', 'Follow us for announcements', 500, 'https://x.com/lykan_official')
on conflict do nothing;
