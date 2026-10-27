#!/bin/bash
# Replace the complete verified app bundle; never edit Resources or user vaults.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
WORK="$1"; TARGET="$2"; OLD_PID="$3"; CURRENT="$4"; NEXT="$5"; TOKEN="$6"; STATUS="$7"; HEALTH_WAIT="${8:-90}"
APP_ID='com.slabsngrabsaco.jigstudio.owner'
[[ "$TOKEN" =~ ^[a-f0-9-]{36}$ && "$OLD_PID" =~ ^[0-9]+$ && "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$NEXT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
[[ "$HEALTH_WAIT" =~ ^[0-9]+$ && "$HEALTH_WAIT" -ge 8 && "$HEALTH_WAIT" -le 120 ]] || exit 2
case "$TARGET" in
 /Applications/'ACO Studio.app'|"$HOME/Applications/ACO Studio.app"|/Applications/'SLABSNGRABSACO ACO Studio.app'|"$HOME/Applications/SLABSNGRABSACO ACO Studio.app") ;;
 *) exit 2;;
esac
[[ "$WORK" == "${STATUS%/*}/aco-native-updates/$TOKEN" && "$STATUS" == */aco-native-update-status.json ]] || exit 2
[[ ! -L "$TARGET" && -d "$TARGET" && -d "$WORK" ]] || exit 2
PARENT="${TARGET%/*}"
STAGE="$PARENT/.ACO-Studio-incoming-$TOKEN.app"
BACKUP="$PARENT/.ACO-Studio-previous-$TOKEN.app"
FAILED="$PARENT/.ACO-Studio-failed-$TOKEN.app"
LOG="$WORK/install.log"
MOVED=0; INSTALLED=0
log(){ printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"; }
status(){
 printf '{"phase":"%s","currentVersion":"%s","targetVersion":"%s","message":"%s","token":"%s"}\n' "$1" "$CURRENT" "$NEXT" "$2" "$TOKEN" > "$STATUS.tmp"
 /bin/chmod 600 "$STATUS.tmp"; /bin/mv -f "$STATUS.tmp" "$STATUS"
}
stopNewApp(){
 if [[ -f "$WORK/started.pid" ]]; then
  PID="$(cat "$WORK/started.pid")"
  if [[ "$PID" =~ ^[0-9]+$ ]]; then
   CMD="$(/bin/ps -p "$PID" -o command= 2>/dev/null || true)"
   case "$CMD" in "$TARGET/Contents/MacOS/"*) /bin/kill -TERM "$PID" 2>/dev/null || true; /bin/sleep 2;; esac
  fi
 fi
}
cleanup(){
 code=$?
 if [[ "$INSTALLED" -eq 0 && "$MOVED" -eq 1 && -d "$BACKUP" ]]; then
  stopNewApp
  if [[ -d "$TARGET" ]]; then /bin/mv "$TARGET" "$FAILED" || true; fi
  if /bin/mv "$BACKUP" "$TARGET"; then
   status rolledback 'The new app did not finish startup. Your previous app was restored; saved data was not changed.'
   log 'Rollback completed.'
   /usr/bin/open "$TARGET" || true
  else
   status failed 'Automatic restore failed. The previous app remains in the update backup beside Applications.'
  fi
 elif [[ "$INSTALLED" -eq 0 ]]; then
  status failed 'The update stopped before replacement. Your existing application and saved data remain in place.'
 fi
 # Keep the failed/new backup for diagnosis. Only this job-owned staging path is removed.
 if [[ -d "$STAGE" && ! -L "$STAGE" ]]; then /bin/rm -rf "$STAGE"; fi
 if [[ -f "${STATUS%/*}/aco-native-update.lock" && "$(cat "${STATUS%/*}/aco-native-update.lock")" == "$TOKEN:$OLD_PID" ]]; then /bin/rm -f "${STATUS%/*}/aco-native-update.lock"; fi
 log "Helper exit $code"
}
trap cleanup EXIT
[[ -d "$STAGE" && ! -L "$STAGE" && ! -e "$BACKUP" && ! -e "$FAILED" ]] || exit 3
/usr/bin/codesign --verify --deep --strict "$STAGE" >> "$LOG" 2>&1
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$STAGE/Contents/Info.plist")" == "$APP_ID" ]] || exit 3
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$STAGE/Contents/Info.plist")" == "$NEXT" ]] || exit 3
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TARGET/Contents/Info.plist")" == "$APP_ID" ]] || exit 3
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET/Contents/Info.plist")" == "$CURRENT" ]] || exit 3
# Signal only after every prerequisite is satisfied. The app does not quit earlier.
printf 'ready' > "$WORK/ready"
for ((i=0;i<180;i++)); do
 if ! /bin/kill -0 "$OLD_PID" 2>/dev/null; then break; fi
 /bin/sleep 0.5
done
if /bin/kill -0 "$OLD_PID" 2>/dev/null; then log 'Current app did not quit; update cancelled.'; exit 4; fi
status installing 'Installing the complete verified app. Saved Personal and customer data are not modified.'
/bin/mv "$TARGET" "$BACKUP"; MOVED=1
/bin/mv "$STAGE" "$TARGET"
/usr/bin/codesign --verify --deep --strict "$TARGET" >> "$LOG" 2>&1
log "Launching $NEXT"
if [[ "${ACO_SELF_UPDATE_CI:-}" == "1" ]]; then
  /usr/bin/open "$TARGET" --args "--aco-update-token=$TOKEN" "--aco-ci-self-update" >> "$LOG" 2>&1
else
  /usr/bin/open "$TARGET" --args "--aco-update-token=$TOKEN" >> "$LOG" 2>&1
fi
for ((i=0;i<HEALTH_WAIT;i++)); do
 if [[ -f "$WORK/healthy" && "$(cat "$WORK/healthy")" == "$NEXT" ]]; then
  INSTALLED=1
  status installed 'Update installed and restarted successfully. Your saved data was retained.'
  log 'New version confirmed a healthy desktop renderer.'
  break
 fi
 /bin/sleep 1
done
[[ "$INSTALLED" -eq 1 ]] || { log 'New app did not confirm startup; restoring the previous app.'; exit 5; }
# Retain one known-good backup for this update. No automated vault deletion.
exit 0
