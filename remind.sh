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
[ $# -ge 3 ] || exit 1
dir=$1 key=$2
shift 2

case $key in *[!0-9a-f]*) exit 1 ;; esac
[ ${#key} -eq 32 ] || exit 1

mkdir -p "$dir" || exit 1
exec 9>"$dir/.lock" || exit 1
flock -w 10 9 || exit 2

find "$dir" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[0-9a-f]{32}' -mtime +60 -delete 2>/dev/null

[ -e "$dir/$key" ] && exit 0
: > "$dir/$key" || exit 1
exec 9>&-
exec omarchy-notification-send "$@"
