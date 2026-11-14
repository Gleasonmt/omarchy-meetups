#!/usr/bin/env bash
# Downloads URL to DIR/NAME unless that copy is younger than MAX_AGE minutes
# (0 always downloads). Used for omarchy.org's meetup list and, when needed,
# geo.omarchy.org's answer.
#
#   fetch.sh DIR NAME URL MAX_AGE MAX_BYTES
#
# - The download goes to a private temporary file first and is renamed into
#   place only when complete, so a reader never sees half a file and a failed
#   download keeps the old copy.
# - Files are created 0600 (mktemp) whatever the umask.
# - One download at a time per folder: every monitor's bar runs this, and the
#   ones that find the lock taken leave it to the one holding it.
# - Temporary files left by a download that was killed (the shell quitting
#   mid-download) are removed on the next run.
# Exit codes: 0 done or fresh enough, 1 failed, 2 another download is running.

set -u
umask 077
dir=$1 name=$2 url=$3 age=$4 max_bytes=$5
file=$dir/$name

case $url in https://*) ;; *) exit 1 ;; esac
case $age$max_bytes in *[!0-9]*) exit 1 ;; esac

mkdir -p "$dir" || exit 1
exec 9>"$dir/.lock" || exit 1
flock -n 9 || exit 2

find "$dir" -maxdepth 1 -name '.dl.*' -mmin +5 -delete 2>/dev/null

if [ "$age" -gt 0 ] && [ -n "$(find "$file" -mmin -"$age" 2>/dev/null)" ]; then
  exit 0
fi

tmp=$(mktemp "$dir/.dl.XXXXXX") || exit 1
if curl -fsSL --proto '=https' --max-time 15 --max-filesize "$max_bytes" "$url" -o "$tmp"; then
  mv -f "$tmp" "$file"
else
  rm -f "$tmp"
  exit 1
fi
