#!/bin/bash
cd "$(dirname "$0")/.."
P="psql -h /var/tmp/pgtest -p 5499 -U postgres -q"
$P -c "drop database if exists t" -c "create database t" >/dev/null 2>&1
$P -d t -f test/supabase_stub.sql >/dev/null
for f in sql/0*.sql; do $P -d t -f $f 2>&1 | grep -v NOTICE; done
$P -d t -c "insert into auth.users values ('11111111-1111-1111-1111-111111111111','scott@creativelysquared.com','{\"name\":\"Scott Thomas\"}','{\"provider\":\"linkedin_oidc\"}'),('22222222-2222-2222-2222-222222222222','jane@example.com','{\"name\":\"Jane Doe\",\"picture\":\"https://broken.invalid/x.jpg\"}','{\"provider\":\"linkedin_oidc\"}')" >/dev/null
