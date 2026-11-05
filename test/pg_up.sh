#!/bin/bash
D=/var/tmp/pgtest
psql -h $D -p 5499 -U postgres -tc "select 1" >/dev/null 2>&1 && exit 0
rm -f $D/data/postmaster.pid
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $D/data -o '-p 5499 -k $D' -l $D/log -w start" >/dev/null
