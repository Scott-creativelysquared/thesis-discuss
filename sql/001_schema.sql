-- Creatively Squared thesis: discussion, sharing and attribution
-- All writes go through security definer functions. Tables are not directly readable or writable by anon/authenticated.

create extension if not exists pgcrypto;

-- ---------- Admins ----------
create table if not exists public.admin_emails (
  email text primary key check (email = lower(email))
);
alter table public.admin_emails enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.admin_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.is_linkedin_user() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null
     and coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'linkedin_oidc';
$$;

-- ---------- Profiles (public: name, photo, optional profile link) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'LinkedIn member',
  avatar_url text,
  linkedin_url text check (
    linkedin_url is null or linkedin_url ~ '^https://([a-z]{2,3}\.)?linkedin\.com/in/[A-Za-z0-9_%-]{2,100}/?$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.handle_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(btrim(m ->> 'full_name'), ''),
      nullif(btrim(m ->> 'name'), ''),
      nullif(btrim(concat_ws(' ', m ->> 'given_name', m ->> 'family_name')), ''),
      'LinkedIn member'),
    nullif(coalesce(m ->> 'avatar_url', m ->> 'picture'), '')
  )
  on conflict (id) do update
    set full_name = excluded.full_name,
        avatar_url = excluded.avatar_url,
        updated_at = now();
  return new;
end $$;

drop trigger if exists on_auth_user_change on auth.users;
create trigger on_auth_user_change
  after insert or update of raw_user_meta_data on auth.users
  for each row execute function public.handle_auth_user();

-- ---------- Comments ----------
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  article text not null check (article ~ '^[a-z0-9-]{1,64}$'),
  parent_id uuid references public.comments(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  section text check (section ~ '^[A-Za-z0-9_-]{1,100}$'),
  passage text check (passage ~ '^[A-Za-z0-9_-]{1,120}$'),
  quote text check (char_length(quote) <= 600),
  status text not null default 'published' check (status in ('published', 'hidden', 'deleted')),
  ref_token text,
  visit_id uuid,
  created_at timestamptz not null default now(),
  moderated_at timestamptz,
  moderated_by uuid
);
create index if not exists comments_article_idx on public.comments (article, created_at);
create index if not exists comments_parent_idx on public.comments (parent_id);
create index if not exists comments_author_idx on public.comments (author_id, created_at);
alter table public.comments enable row level security;

-- ---------- Sections (titles, registered by the page so the dashboard can show names) ----------
create table if not exists public.sections (
  article text not null,
  section text not null,
  title text not null,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (article, section)
);
alter table public.sections enable row level security;

-- ---------- Share actions ----------
create table if not exists public.share_events (
  token text primary key check (token ~ '^[A-Za-z0-9]{10}$'),
  article text not null check (article ~ '^[a-z0-9-]{1,64}$'),
  channel text not null check (channel in
    ('teams','linkedin','whatsapp','email','copy','slack','facebook','x','bluesky','telegram','native')),
  kind text not null check (kind in ('article','section','excerpt','comment')),
  section text,
  passage text,
  quote text check (char_length(quote) <= 600),
  comment_id uuid references public.comments(id) on delete set null,
  sharer_id uuid references public.profiles(id) on delete set null,
  parent_token text,
  visit_id uuid,
  device text check (device in ('mobile','desktop')),
  created_at timestamptz not null default now()
);
create index if not exists share_events_article_idx on public.share_events (article, created_at);
create index if not exists share_events_parent_idx on public.share_events (parent_token);
alter table public.share_events enable row level security;

-- ---------- Visits ----------
create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  article text not null,
  token text,
  referrer_host text,
  user_id uuid,
  is_self boolean not null default false,
  device text check (device in ('mobile','desktop')),
  landing_passage text,
  max_scroll smallint not null default 0,
  active_seconds int not null default 0,
  reached_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists visits_article_idx on public.visits (article, created_at);
create index if not exists visits_token_idx on public.visits (token);
alter table public.visits enable row level security;

-- ---------- Optional notification hook (Slack incoming webhook) ----------
create table if not exists public.app_settings (key text primary key, value text);
alter table public.app_settings enable row level security;

-- Lock tables down: everything goes through functions below
revoke all on public.admin_emails, public.profiles, public.comments, public.sections,
  public.share_events, public.visits, public.app_settings from anon, authenticated;

-- =====================================================================
-- Functions
-- =====================================================================

create or replace function public.valid_token(t text) returns boolean
language sql immutable as $$ select t is not null and t ~ '^[A-Za-z0-9]{10}$' $$;

-- Public comment feed. Hidden or deleted comments only appear as placeholders when they have published replies.
create or replace function public.get_comments(p_article text)
returns table (
  id uuid, parent_id uuid, body text, section text, passage text, quote text, status text,
  created_at timestamptz, author_name text, author_avatar text, author_linkedin text,
  is_mine boolean, can_moderate boolean
)
language sql stable security definer set search_path = '' as $$
  with adm as (select public.is_admin() as yes)
  select c.id, c.parent_id,
    case when c.status = 'published' or adm.yes then c.body end,
    c.section, c.passage,
    case when c.status = 'published' or adm.yes then c.quote end,
    c.status, c.created_at,
    case when c.status = 'published' or adm.yes then p.full_name end,
    case when c.status = 'published' or adm.yes then p.avatar_url end,
    case when c.status = 'published' or adm.yes then p.linkedin_url end,
    (auth.uid() is not null and c.author_id = auth.uid()),
    adm.yes
  from public.comments c
  join public.profiles p on p.id = c.author_id
  cross join adm
  where c.article = p_article
    and (c.status = 'published' or adm.yes
         or exists (select 1 from public.comments ch where ch.parent_id = c.id and ch.status = 'published'))
  order by c.created_at;
$$;

create or replace function public.get_my_profile()
returns table (id uuid, full_name text, avatar_url text, linkedin_url text, is_admin boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.avatar_url, p.linkedin_url, public.is_admin()
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.set_linkedin_url(p_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text := nullif(btrim(p_url), '');
begin
  if not public.is_linkedin_user() then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v is not null then
    v := regexp_replace(v, '^(https?://)?(www\.)?', 'https://www.');
    v := regexp_replace(v, '[?#].*$', '');
    if v !~ '^https://([a-z]{2,3}\.)?linkedin\.com/in/[A-Za-z0-9_%-]{2,100}/?$' then
      raise exception 'invalid_linkedin_url' using errcode = '22023';
    end if;
  end if;
  update public.profiles set linkedin_url = v, updated_at = now() where id = auth.uid();
  return v;
end $$;

create or replace function public.post_comment(
  p_article text, p_body text, p_parent uuid default null, p_section text default null,
  p_passage text default null, p_quote text default null, p_ref text default null, p_visit uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_parent public.comments;
begin
  if not public.is_linkedin_user() then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.profiles where id = v_uid) then raise exception 'no_profile'; end if;
  p_body := btrim(p_body);
  if p_body is null or char_length(p_body) = 0 or char_length(p_body) > 4000 then
    raise exception 'invalid_body' using errcode = '22023';
  end if;
  if (select count(*) from public.comments where author_id = v_uid and created_at > now() - interval '1 minute') >= 4
     or (select count(*) from public.comments where author_id = v_uid and created_at > now() - interval '1 day') >= 50 then
    raise exception 'rate_limited' using errcode = '22023';
  end if;
  if p_parent is not null then
    select * into v_parent from public.comments where id = p_parent;
    if not found or v_parent.article <> p_article or v_parent.status <> 'published' then
      raise exception 'invalid_parent' using errcode = '22023';
    end if;
    p_section := coalesce(p_section, v_parent.section);
    p_passage := coalesce(p_passage, v_parent.passage);
  end if;
  if not public.valid_token(p_ref) then p_ref := null; end if;
  if p_section !~ '^[A-Za-z0-9_-]{1,100}$' then p_section := null; end if;
  if p_passage !~ '^[A-Za-z0-9_-]{1,120}$' then p_passage := null; end if;

  insert into public.comments (article, parent_id, author_id, body, section, passage, quote, ref_token, visit_id)
  values (p_article, p_parent, v_uid, p_body, p_section, p_passage,
          nullif(left(btrim(coalesce(p_quote, '')), 600), ''), p_ref, p_visit)
  returning id into v_id;

  if p_visit is not null then
    update public.visits set user_id = v_uid where id = p_visit and user_id is null;
  end if;
  return v_id;
end $$;

create or replace function public.delete_own_comment(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  update public.comments set status = 'deleted'
  where id = p_id and author_id = auth.uid() and status = 'published';
end $$;

create or replace function public.moderate_comment(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('published', 'hidden') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.comments
     set status = p_status, moderated_at = now(), moderated_by = auth.uid()
   where id = p_id and status <> 'deleted';
end $$;

create or replace function public.register_sections(p_article text, p_sections jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s jsonb; i int := 0;
begin
  if p_article !~ '^[a-z0-9-]{1,64}$' or jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) > 80 then
    return;
  end if;
  for s in select * from jsonb_array_elements(p_sections) loop
    i := i + 1;
    if (s ->> 'id') ~ '^[A-Za-z0-9_-]{1,100}$' and char_length(coalesce(s ->> 'title', '')) between 1 and 200 then
      insert into public.sections (article, section, title, position)
      values (p_article, s ->> 'id', s ->> 'title', i)
      on conflict (article, section) do update
        set title = excluded.title, position = excluded.position, updated_at = now()
        where public.sections.title is distinct from excluded.title or public.sections.position <> excluded.position;
    end if;
  end loop;
end $$;

-- Records a share action (intent: the button was used). Never claims the share was completed.
create or replace function public.record_share(
  p_token text, p_article text, p_channel text, p_kind text,
  p_section text default null, p_passage text default null, p_quote text default null,
  p_comment uuid default null, p_parent text default null, p_visit uuid default null, p_device text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.valid_token(p_token) then raise exception 'invalid_token' using errcode = '22023'; end if;
  if (select count(*) from public.share_events where created_at > now() - interval '1 minute') > 300 then
    raise exception 'rate_limited' using errcode = '22023';
  end if;
  if not public.valid_token(p_parent) or not exists (select 1 from public.share_events where token = p_parent) then
    p_parent := null;
  end if;
  if p_comment is not null and not exists (select 1 from public.comments where id = p_comment and article = p_article) then
    p_comment := null;
  end if;
  insert into public.share_events
    (token, article, channel, kind, section, passage, quote, comment_id, sharer_id, parent_token, visit_id, device)
  values
    (p_token, p_article, p_channel, p_kind,
     case when p_section ~ '^[A-Za-z0-9_-]{1,100}$' then p_section end,
     case when p_passage ~ '^[A-Za-z0-9_-]{1,120}$' then p_passage end,
     nullif(left(btrim(coalesce(p_quote, '')), 600), ''),
     p_comment,
     case when public.is_linkedin_user() then auth.uid() end,
     p_parent, p_visit,
     case when p_device in ('mobile','desktop') then p_device end)
  on conflict (token) do nothing;
end $$;

-- Records a page view. Returns the visit id plus what the share link pointed at, so the page can highlight it.
create or replace function public.record_visit(
  p_article text, p_token text default null, p_referrer_host text default null,
  p_device text default null, p_passage text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; s public.share_events; v_found boolean := false;
begin
  if p_article !~ '^[a-z0-9-]{1,64}$' then raise exception 'invalid_article' using errcode = '22023'; end if;
  if public.valid_token(p_token) then
    select * into s from public.share_events where token = p_token;
    v_found := found;
  end if;
  insert into public.visits (article, token, referrer_host, user_id, is_self, device, landing_passage)
  values (
    p_article,
    case when v_found then p_token end,
    left(lower(nullif(btrim(p_referrer_host), '')), 120),
    case when public.is_linkedin_user() then auth.uid() end,
    coalesce(v_found and s.sharer_id is not null and s.sharer_id = auth.uid(), false),
    case when p_device in ('mobile','desktop') then p_device end,
    case when p_passage ~ '^[A-Za-z0-9_-]{1,120}$' then p_passage end
  ) returning id into v_id;
  return jsonb_build_object(
    'visit_id', v_id,
    'share', case when v_found then jsonb_build_object(
      'kind', s.kind, 'section', s.section, 'passage', s.passage, 'quote', s.quote, 'comment_id', s.comment_id)
    end);
end $$;

create or replace function public.record_engagement(
  p_visit uuid, p_scroll int, p_seconds int, p_end boolean
) returns void
language sql security definer set search_path = '' as $$
  update public.visits set
    max_scroll = greatest(max_scroll, least(greatest(coalesce(p_scroll, 0), 0), 100)),
    active_seconds = greatest(active_seconds, least(greatest(coalesce(p_seconds, 0), 0), 14400)),
    reached_end = reached_end or coalesce(p_end, false),
    updated_at = now()
  where id = p_visit and created_at > now() - interval '1 day';
$$;

-- Admin dashboard data.
create or replace function public.dashboard_data(p_article text, p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := case when p_days is null or p_days <= 0 then '-infinity'::timestamptz
                             else now() - make_interval(days => p_days) end;
  r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;

  with recursive
  sh as (select * from public.share_events where article = p_article and created_at >= v_from),
  vi as (select * from public.visits where article = p_article and created_at >= v_from and not is_self),
  allsh as (select * from public.share_events where article = p_article),
  vis_tok as (  -- referred visits, attributed to the channel of the link they arrived on
    select v.*, s.channel, s.kind, s.sharer_id, s.quote, s.passage as s_passage, s.section as s_section
    from vi v join allsh s on s.token = v.token
  ),
  cm as (select * from public.comments where article = p_article and created_at >= v_from),
  chain as (
    select token, parent_token, 1 as gen from allsh where parent_token is null
    union all
    select s.token, s.parent_token, c.gen + 1 from allsh s join chain c on s.parent_token = c.token where c.gen < 20
  )
  select jsonb_build_object(
    'generated_at', now(),
    'days', p_days,
    'totals', jsonb_build_object(
      'visits', (select count(*) from vi),
      'referred_visits', (select count(*) from vis_tok),
      'share_actions', (select count(*) from sh),
      'identified_share_actions', (select count(*) from sh where sharer_id is not null),
      'comments', (select count(*) from cm where status <> 'deleted'),
      'comments_from_referrals', (select count(*) from cm where ref_token is not null and status <> 'deleted'),
      'commenters', (select count(distinct author_id) from cm),
      'reached_end', (select count(*) from vi where reached_end),
      'avg_active_seconds', (select coalesce(round(avg(active_seconds)), 0) from vi where active_seconds > 0)
    ),
    'channels', coalesce((
      select jsonb_agg(x order by x.share_actions desc, x.visits desc) from (
        select ch as channel,
          (select count(*) from sh where sh.channel = ch) as share_actions,
          (select count(*) from vis_tok where vis_tok.channel = ch) as visits,
          (select count(distinct vis_tok.token) from vis_tok where vis_tok.channel = ch) as links_opened,
          (select count(*) from vis_tok where vis_tok.channel = ch and reached_end) as read_to_end,
          (select count(*) from cm join allsh s on s.token = cm.ref_token where s.channel = ch and cm.status <> 'deleted') as comments,
          (select count(*) from sh s2 join allsh p on p.token = s2.parent_token where p.channel = ch) as reshares
        from unnest(array['teams','linkedin','whatsapp','email','copy','slack','facebook','x','bluesky','telegram','native']) ch
      ) x where x.share_actions > 0 or x.visits > 0), '[]'::jsonb),
    'referrers', coalesce((
      select jsonb_agg(x order by x.visits desc) from (
        select coalesce(referrer_host, '(direct or hidden)') as host, count(*) as visits
        from vi where token is null group by 1 order by 2 desc limit 15
      ) x), '[]'::jsonb),
    'excerpts', coalesce((
      select jsonb_agg(x order by x.share_actions desc, x.visits desc) from (
        select s.quote, min(s.passage) as passage, min(s.section) as section,
          (select title from public.sections t where t.article = p_article and t.section = min(s.section)) as section_title,
          count(*) as share_actions,
          (select count(*) from vis_tok v where v.quote = s.quote) as visits,
          array_agg(distinct s.channel) as channels
        from sh s where s.kind = 'excerpt' and s.quote is not null
        group by s.quote order by count(*) desc limit 15
      ) x), '[]'::jsonb),
    'sections', coalesce((
      select jsonb_agg(x order by x.comments desc, x.share_actions desc, x.position) from (
        select t.section, t.title, t.position,
          (select count(*) from cm where cm.section = t.section and cm.status <> 'deleted') as comments,
          (select count(*) from cm where cm.section = t.section and cm.parent_id is not null and cm.status <> 'deleted') as replies,
          (select count(distinct author_id) from cm where cm.section = t.section) as participants,
          (select count(*) from sh where sh.section = t.section) as share_actions,
          (select count(*) from vi where vi.landing_passage like t.section || '%' or vi.landing_passage = t.section) as landings
        from public.sections t where t.article = p_article
      ) x where x.comments > 0 or x.share_actions > 0 or x.landings > 0), '[]'::jsonb),
    'sharers', coalesce((
      select jsonb_agg(x order by x.visits desc, x.share_actions desc) from (
        select p.id, p.full_name, p.avatar_url, p.linkedin_url, u.email,
          count(*) as share_actions,
          array_agg(distinct s.channel) as channels,
          (select count(*) from vis_tok v where v.sharer_id = p.id) as visits,
          (select count(*) from cm join allsh s3 on s3.token = cm.ref_token where s3.sharer_id = p.id and cm.status <> 'deleted') as comments,
          (select count(*) from allsh s2 join allsh pp on pp.token = s2.parent_token where pp.sharer_id = p.id) as reshares,
          max(s.created_at) as last_share
        from sh s join public.profiles p on p.id = s.sharer_id
        left join auth.users u on u.id = p.id
        group by p.id, p.full_name, p.avatar_url, p.linkedin_url, u.email
        order by count(*) desc limit 50
      ) x), '[]'::jsonb),
    'referral_comments', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select cm.id, cm.body, cm.created_at, cm.section, cm.parent_id is not null as is_reply, cm.status,
          a.full_name as author, s.channel, s.kind,
          sp.full_name as sharer
        from cm
        join public.profiles a on a.id = cm.author_id
        join allsh s on s.token = cm.ref_token
        left join public.profiles sp on sp.id = s.sharer_id
        where cm.status <> 'deleted'
        order by cm.created_at desc limit 50
      ) x), '[]'::jsonb),
    'generations', coalesce((
      select jsonb_agg(x order by x.gen) from (
        select c.gen, count(*) as share_actions,
          (select count(*) from vis_tok v where v.token in (select c2.token from chain c2 where c2.gen = c.gen)) as visits
        from chain c join sh on sh.token = c.token group by c.gen
      ) x), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(x order by x.day) from (
        select d::date as day,
          (select count(*) from vi where vi.created_at::date = d::date) as visits,
          (select count(*) from vis_tok where vis_tok.created_at::date = d::date) as referred,
          (select count(*) from sh where sh.created_at::date = d::date) as shares,
          (select count(*) from cm where cm.created_at::date = d::date) as comments
        from generate_series(
          greatest(date_trunc('day', v_from), coalesce((select date_trunc('day', min(created_at)) from public.visits where article = p_article), date_trunc('day', now()))),
          date_trunc('day', now()), interval '1 day') d
      ) x), '[]'::jsonb),
    'recent_comments', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select c.id, c.body, c.status, c.created_at, c.section, c.parent_id is not null as is_reply,
          p.full_name as author, p.linkedin_url, u.email
        from public.comments c
        join public.profiles p on p.id = c.author_id
        left join auth.users u on u.id = c.author_id
        where c.article = p_article
        order by c.created_at desc limit 40
      ) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- ---------- Optional: notify Slack on new comments (only if app_settings.slack_webhook_url is set and pg_net is enabled) ----------
create or replace function public.notify_new_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_name text; v_page text;
begin
  select value into v_url from public.app_settings where key = 'slack_webhook_url';
  select value into v_page from public.app_settings where key = 'article_url';
  if v_url is null or not exists (select 1 from pg_extension where extname = 'pg_net') then return new; end if;
  select full_name into v_name from public.profiles where id = new.author_id;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('text',
      format('New %s on the thesis from %s: %s %s',
        case when new.parent_id is null then 'comment' else 'reply' end,
        coalesce(v_name, 'someone'), left(new.body, 280),
        coalesce(v_page || '#comment-' || new.id, ''))),
    headers := '{"Content-Type":"application/json"}'::jsonb);
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists on_comment_insert on public.comments;
create trigger on_comment_insert after insert on public.comments
  for each row execute function public.notify_new_comment();

-- ---------- Grants ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_comments(text) to anon, authenticated;
grant execute on function public.record_share(text, text, text, text, text, text, text, uuid, text, uuid, text) to anon, authenticated;
grant execute on function public.record_visit(text, text, text, text, text) to anon, authenticated;
grant execute on function public.record_engagement(uuid, int, int, boolean) to anon, authenticated;
grant execute on function public.register_sections(text, jsonb) to anon, authenticated;
grant execute on function public.get_my_profile() to authenticated;
grant execute on function public.set_linkedin_url(text) to authenticated;
grant execute on function public.post_comment(text, text, uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.delete_own_comment(uuid) to authenticated;
grant execute on function public.moderate_comment(uuid, text) to authenticated;
grant execute on function public.dashboard_data(text, int) to authenticated;
-- helpers used inside definer functions and RLS
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_linkedin_user() to anon, authenticated;
grant execute on function public.valid_token(text) to anon, authenticated;

insert into public.admin_emails (email) values ('scott@creativelysquared.com') on conflict do nothing;
