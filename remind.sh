#!/usr/bin/env bash
# Sends one meetup reminder, once, however many bars ask for it.
#
#   remind.sh DIR KEY ARGS...
#
# KEY names this reminder (an md5 of the meetup and which reminder it is,
# 32 hex characters). The first call for a KEY records it in DIR and passes
# ARGS to omarchy-notification-send; every later call, from this bar or
# another monitor's, finds the record and sends nothing.
# - The check and the record happen under one lock, so two bars asking at the
#   same moment still send one notification.
# - The record is written before sending: a failed send isn't retried, so a
#   reminder can be missed but never repeated.
# - Records are empty files, 0600 in a 0700 folder, removed after 60 days.
# Exit codes: 0 sent or already sent, 1 refused or failed, 2 lock busy.

set -u
umask 077

# The folder must be this account's alone, or another account could plant a
# symlink where the lock or a record goes and have this script write through
# it: a real folder (not a symlink), owned by this user, writable by no one
# else, and every folder above it owned by this user or root and writable by
# no one else unless sticky (like /tmp). Otherwise nothing is touched.
private_dir() {
  local d mode
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] || return 1
  d=$(cd -P -- "$1" && pwd -P) || return 1
  mode=$(stat -c %a -- "$d") || return 1
  (( 8#$mode & 8#022 )) && return 1
  while [ "$d" != / ]; do
    d=$(dirname -- "$d")
    [ -O "$d" ] || [ "$(stat -c %u -- "$d")" = 0 ] || return 1
    mode=$(stat -c %a -- "$d") || return 1
    if (( 8#$mode & 8#022 )) && [ ! -k "$d" ]; then return 1; fi
  done
}

[ $# -ge 3 ] || exit 1
dir=$1 key=$2
shift 2

case $key in *[!0-9a-f]*) exit 1 ;; esac
[ ${#key} -eq 32 ] || exit 1

mkdir -p "$dir" || exit 1
private_dir "$dir" || exit 1
# <> opens without truncating, so even a planted lock would never be emptied.
exec 9<>"$dir/.lock" || exit 1
flock -w 10 9 || exit 2

find "$dir" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[0-9a-f]{32}' -mtime +60 -delete 2>/dev/null

[ -e "$dir/$key" ] && exit 0
# noclobber: the record is created new (O_EXCL), never written through a symlink.
(set -C; : > "$dir/$key") || exit 1
exec 9>&-
exec omarchy-notification-send "$@"
