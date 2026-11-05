\set ON_ERROR_STOP 1
-- users
insert into auth.users values
 ('11111111-1111-1111-1111-111111111111','scott@creativelysquared.com','{"name":"Scott Thomas","picture":"https://media.licdn.com/a.jpg"}','{"provider":"linkedin_oidc"}'),
 ('22222222-2222-2222-2222-222222222222','jane@example.com','{"given_name":"Jane","family_name":"Doe"}','{"provider":"linkedin_oidc"}'),
 ('33333333-3333-3333-3333-333333333333','email@example.com','{}','{"provider":"email"}');
select id, full_name, avatar_url from public.profiles order by id;

-- anon: visit, share, read
set role anon;
select set_config('request.jwt.claims','{}',false);
select public.register_sections('thesis','[{"id":"intro","title":"Introduction"},{"id":"the-biggest-lever","title":"The biggest lever"}]');
select public.record_share('AAAAAAAAAA','thesis','whatsapp','excerpt','the-biggest-lever','the-biggest-lever--p2','Social is the biggest channel', null, null, null,'mobile');
select public.record_visit('thesis','AAAAAAAAAA','web.whatsapp.com','mobile','the-biggest-lever--p2') ->> 'share';
select public.record_visit('thesis', null, 'google.com', 'desktop', null) is not null as direct_visit;
do $$ begin perform public.post_comment('thesis','anon should fail'); raise exception 'should not reach'; exception when sqlstate '28000' or insufficient_privilege then raise notice 'anon blocked ok'; end $$;
do $$ begin perform * from public.comments; raise exception 'table readable'; exception when insufficient_privilege then raise notice 'table locked ok'; end $$;
do $$ begin perform public.dashboard_data('thesis',30); raise exception 'anon dashboard'; exception when insufficient_privilege then raise notice 'anon dashboard blocked ok'; end $$;

-- Jane (not admin) comments, arriving via the WhatsApp link
reset role; set role authenticated;
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222222","email":"jane@example.com","app_metadata":{"provider":"linkedin_oidc"}}',false);
select public.post_comment('thesis','Great point about reach.', null, 'the-biggest-lever','the-biggest-lever--p2','Social is the biggest channel','AAAAAAAAAA', null) as c1 \gset
select public.set_linkedin_url('linkedin.com/in/jane-doe?trk=x');
-- Jane reshares to Teams, parent = AAAAAAAAAA
select public.record_share('BBBBBBBBBB','thesis','teams','article',null,null,null,null,'AAAAAAAAAA',null,'desktop');
do $$ begin perform public.moderate_comment(gen_random_uuid(),'hidden'); raise exception 'non-admin moderated'; exception when insufficient_privilege then raise notice 'moderation blocked ok'; end $$;
do $$ begin perform public.dashboard_data('thesis',30); raise exception 'non-admin dashboard'; exception when insufficient_privilege then raise notice 'dashboard blocked ok'; end $$;

-- email-provider user cannot comment
select set_config('request.jwt.claims','{"sub":"33333333-3333-3333-3333-333333333333","email":"email@example.com","app_metadata":{"provider":"email"}}',false);
do $$ begin perform public.post_comment('thesis','not linkedin'); raise exception 'email user commented'; exception when sqlstate '28000' then raise notice 'email user blocked ok'; end $$;

-- Scott (admin) replies, then a visitor arrives from Jane's Teams reshare
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","email":"scott@creativelysquared.com","app_metadata":{"provider":"linkedin_oidc"}}',false);
select public.post_comment('thesis','Thanks Jane', :'c1'::uuid) as c2 \gset
select public.record_share('CCCCCCCCCC','thesis','linkedin','comment',null,null,null,:'c2'::uuid,null,null,'desktop');
reset role; set role anon; select set_config('request.jwt.claims','{}',false);
select public.record_visit('thesis','BBBBBBBBBB','teams.microsoft.com','desktop',null) ->> 'visit_id' as v2 \gset
select public.record_engagement(:'v2'::uuid, 87, 240, true);

-- Jane deletes nothing; Scott hides Jane's comment -> public sees placeholder because it has a reply
reset role; set role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","email":"scott@creativelysquared.com","app_metadata":{"provider":"linkedin_oidc"}}',false);
select public.moderate_comment(:'c1'::uuid,'hidden');
reset role; set role anon; select set_config('request.jwt.claims','{}',false);
select status, body, author_name, section from public.get_comments('thesis');
reset role; set role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","email":"scott@creativelysquared.com","app_metadata":{"provider":"linkedin_oidc"}}',false);
select status, body, can_moderate from public.get_comments('thesis');
select jsonb_pretty(public.dashboard_data('thesis', 30));
select * from public.get_my_profile();
