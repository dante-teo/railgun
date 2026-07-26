# dbmate migrations

Only files named `<timestamp>_<description>.sql` are executable migrations.
Other files in this directory are ignored by both the bundled migration runner
and dbmate, so Finder metadata cannot prevent the backend from starting.
