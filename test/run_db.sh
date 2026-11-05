#!/bin/bash
cd "$(dirname "$0")/.."
P="psql -h /var/tmp/pgtest -p 5499 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists t" -c "create database t" >/dev/null 2>&1
$P -d t -f test/supabase_stub.sql || exit 1
for f in sql/0*.sql; do $P -d t -f $f 2>&1 | grep -v NOTICE; done
$P -d t -f test/db_test.sql 2>&1
