#!/usr/bin/env bash
# Fetches one meetup cover for the panel, and lets it through only if it is
# what omarchy.org serves: a still WebP image no larger than 2000x2000.
#
#   cover.sh DIR NAME URL MAX_AGE MAX_BYTES
#
# - The download (fetch.sh: https only, MAX_BYTES cap) lands in DIR/.incoming,
#   which the panel never reads. Only after its bytes pass the check is it
#   moved to DIR/NAME, where the panel shows it, so the shell only ever
#   decodes a checked file.
# - The check reads the header, nothing more: "RIFF....WEBP", then a VP8,
#   VP8L or VP8X chunk with its dimensions, which must be 1..2000 each. PNG,
#   JPEG, animated WebP and anything else are refused, whatever the file is
#   called: the bytes, not the name, decide how an image is decoded.
# - A cover already in DIR/NAME that passes the check and is younger than
#   MAX_AGE minutes: nothing to do. Offline, or given a bad replacement, a
#   cover already there is kept if it passes the check, removed if not.
# - One run per cover at a time (every monitor's bar runs this).
# Exit codes: 0 DIR/NAME is ready, 1 no usable cover, 2 another run has it.

set -u
umask 077
[ $# -eq 5 ] || exit 1
dir=$1 name=$2 url=$3 age=$4 max_bytes=$5
here=$(dirname "$0")
file=$dir/$name
incoming=$dir/.incoming

[[ $name =~ ^[A-Za-z0-9_-]{1,80}\.webp$ ]] || exit 1
case $age in '' | *[!0-9]*) exit 1 ;; esac

mkdir -p "$incoming" || exit 1
exec 8>"$dir/.$name.cover.lock" || exit 1
flock -n 8 || exit 2

# 0 when $1 starts like a still WebP of 1..2000 x 1..2000.
webp_ok() {
  local b w h
  b=($(head -c 30 -- "$1" | od -An -tu1 -v))
  [ ${#b[@]} -eq 30 ] || return 1
  # "RIFF" .... "WEBP"
  [ "${b[*]:0:4}" = "82 73 70 70" ] && [ "${b[*]:8:4}" = "87 69 66 80" ] || return 1
  case "${b[*]:12:4}" in
  "86 80 56 32") # "VP8 ": lossy; start code 9d 01 2a, then 14-bit sizes
    [ "${b[*]:23:3}" = "157 1 42" ] || return 1
    w=$(((b[26] | b[27] << 8) & 0x3fff))
    h=$(((b[28] | b[29] << 8) & 0x3fff))
    ;;
  "86 80 56 76") # "VP8L": lossless; signature 0x2f, then 14-bit sizes - 1
    [ "${b[20]}" -eq 47 ] || return 1
    w=$((1 + (b[21] | (b[22] & 0x3f) << 8)))
    h=$((1 + (b[22] >> 6 | b[23] << 2 | (b[24] & 0x0f) << 10)))
    ;;
  "86 80 56 88") # "VP8X": extended; refuse animation, then 24-bit sizes - 1
    (((b[20] & 0x02) == 0)) || return 1
    w=$((1 + (b[24] | b[25] << 8 | b[26] << 16)))
    h=$((1 + (b[27] | b[28] << 8 | b[29] << 16)))
    ;;
  *) return 1 ;;
  esac
  ((w >= 1 && w <= 2000 && h >= 1 && h <= 2000))
}

# The cover already in place, if it passes the same check (one cached by an
# earlier version, or tampered with, gets none of the benefit of the doubt).
keep_old() {
  [ -e "$file" ] && webp_ok "$file" && exit 0
  rm -f "$file"
  exit 1
}

if [ -e "$file" ] && [ "$age" -gt 0 ] && [ -n "$(find "$file" -mmin -"$age" 2>/dev/null)" ] && webp_ok "$file"; then
  exit 0
fi

bash "$here/fetch.sh" "$incoming" "$name" "$url" 0 "$max_bytes"
code=$?
[ $code -eq 2 ] && exit 2
[ $code -eq 0 ] || keep_old

if webp_ok "$incoming/$name"; then
  mv -f "$incoming/$name" "$file" || exit 1
  exit 0
fi
rm -f "$incoming/$name"
keep_old
