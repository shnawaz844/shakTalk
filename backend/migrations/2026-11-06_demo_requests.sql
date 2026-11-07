-- Demo Requests Table for "Book a Live Demo" Leads
create table if not exists demo_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text not null,
  country text default '',
  language_pair text default '',
  email text not null,
  phone text default '',
  demo_date_1 text not null,
  demo_date_2 text,
  demo_date_3 text,
  assigned_to text default 'sales@shaktalk.com',
  created_at timestamptz default now()
);

alter table demo_requests enable row level security;

create policy "Service role full access on demo_requests"
  on demo_requests for all
  using (true)
  with check (true);

create index if not exists idx_demo_requests_created_at on demo_requests (created_at desc);
create index if not exists idx_demo_requests_email on demo_requests (email);

