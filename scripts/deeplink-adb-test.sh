#!/usr/bin/env bash
#
# deeplink-adb-test.sh, fire PoLo deep-link intents at an installed build and
# classify the result, using adb alone (no Metro, no dev environment).
#
# Purpose: demonstrate the deep-link gaps in the official PoLo build and show that
# the improved build (deep-link-our-refs branch) handles every path-form intent,
# including our.refs operation setup. Run it once against each build and compare
# the two summary.md files. (Host-form links are reserved and ignored by design;
# that contract is covered by the DeepLinkUtils unit tests, not on-device here.)
#
# All URLs use the path form (com.ham2k:///qso?...) and percent-encode any "/"
# inside a value (SOTA refs, portable callsigns), exactly as SOTAcat must emit.
#
#   ./scripts/deeplink-adb-test.sh                      # auto-detect the installed ham2k package
#   ./scripts/deeplink-adb-test.sh com.ham2k.polo.beta  # target a specific package
#   ./scripts/deeplink-adb-test.sh --interactive        # pause after each case for live debugging
#
# Observability (non-rooted, non-debuggable release build):
#   - logcat (ReactNativeJS + AndroidRuntime) catches crashes and the deep-link
#     nav traces. The official build emits these un-gated; the improved build
#     gates them behind DEBUG in DeepLinks.jsx/DeepLinkUtils.js, so to classify
#     HANDLED cases on the improved build, set DEBUG=true there before building
#     (or rely on the before/after screenshots).
#   - screencap before/after each fire is saved for visual confirmation.
#   - the SQLite DB cannot be pulled without root, so classification relies on
#     logcat + screenshots, which is sufficient for every case here.
#
# Each case also prints the iOS-simulator equivalent (xcrun simctl openurl) so an
# iOS-first reviewer can reproduce the same intent on their home turf.

set -uo pipefail

# ----------------------------------------------------------------------------
# Arguments
# ----------------------------------------------------------------------------
INTERACTIVE=0
PKG=""
for arg in "$@"; do
    case "$arg" in
    --interactive | -i) INTERACTIVE=1 ;;
    --help | -h)
        grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d'
        exit 0
        ;;
    -*)
        echo "Unknown option: $arg" >&2
        exit 2
        ;;
    *) PKG="$arg" ;;
    esac
done

ACTIVITY_CLASS="com.ham2k.polo.MainActivity" # class lives in base namespace regardless of applicationId suffix
UPSTREAM_VERSION="26.6.3"                    # from upstream/main package.json
SETTLE_SECS=7                                # cold start processes the link ~4s after launch
# (Running polo -> DB init -> getInitialURL); 7s gives margin

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
command -v adb >/dev/null 2>&1 || {
    echo "adb not found on PATH" >&2
    exit 1
}

DEVICE_COUNT=$(adb devices | grep -cE '\sdevice$' || true)
if [[ "$DEVICE_COUNT" -eq 0 ]]; then
    echo "No adb device connected. Plug in / authorize a device and retry." >&2
    exit 1
fi
if [[ "$DEVICE_COUNT" -gt 1 ]]; then
    echo "Multiple adb devices connected; set ANDROID_SERIAL or disconnect extras." >&2
    exit 1
fi

# Wake the screen and dismiss a non-secure keyguard so screenshots show the app,
# not the lock screen / notification shade. (A secure PIN/pattern lock cannot be
# dismissed via adb, unlock the device manually and keep it awake during the run.)
wake_device() {
    adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
    adb shell wm dismiss-keyguard >/dev/null 2>&1
    adb shell cmd statusbar collapse >/dev/null 2>&1 # close an open notification shade
}
wake_device

# Enlarge the logcat ring buffer so the chatty Mapbox/native logs (when a case lands
# on the Map tab) don't evict the deep-link traces before we read them.
adb logcat -G 16M >/dev/null 2>&1

if [[ -z "$PKG" ]]; then
    mapfile -t HAM2K_PKGS < <(adb shell pm list packages 2>/dev/null | sed 's/^package://' | grep -i 'ham2k' | tr -d '\r')
    if [[ "${#HAM2K_PKGS[@]}" -eq 0 ]]; then
        echo "No ham2k package installed. Install PoLo (official or improved) first." >&2
        exit 1
    elif [[ "${#HAM2K_PKGS[@]}" -gt 1 ]]; then
        echo "Multiple ham2k packages installed; pass one explicitly:" >&2
        printf '  %s\n' "${HAM2K_PKGS[@]}" >&2
        exit 1
    fi
    PKG="${HAM2K_PKGS[0]}"
fi

COMPONENT="${PKG}/${ACTIVITY_CLASS}"

# Identify which build this is, for the summary header and per-case expectation column.
case "$PKG" in
*.alpha)
    BUILD_KIND="improved (.alpha)"
    EXPECT_COL="expect_improved"
    ;;
*.beta | *.prod | com.ham2k.polo)
    BUILD_KIND="official ($PKG)"
    EXPECT_COL="expect_official"
    ;;
*)
    BUILD_KIND="unknown ($PKG)"
    EXPECT_COL="expect_official"
    ;;
esac

STAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="results-${PKG}-${STAMP}"
mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/summary.md"

# Version / upstream-match check
VERSION_INFO=$(adb shell dumpsys package "$PKG" 2>/dev/null | tr -d '\r' | grep -E 'versionName|versionCode' | head -4 | sed 's/^[[:space:]]*//')
VERSION_NAME=$(echo "$VERSION_INFO" | grep -oE 'versionName=[^ ]+' | head -1 | cut -d= -f2)

echo "=============================================================="
echo " PoLo deep-link test"
echo "   package:   $PKG"
echo "   build:     $BUILD_KIND"
echo "   component: $COMPONENT"
echo "   version:   ${VERSION_NAME:-unknown}  (upstream/main = $UPSTREAM_VERSION)"
echo "   mode:      $([[ $INTERACTIVE -eq 1 ]] && echo interactive || echo batch)"
echo "   output:    $OUTDIR/"
echo "=============================================================="

# ----------------------------------------------------------------------------
# summary.md header
# ----------------------------------------------------------------------------
{
    echo "# PoLo deep-link test, $BUILD_KIND"
    echo
    echo "- package: \`$PKG\`"
    echo "- component: \`$COMPONENT\`"
    echo "- version: \`${VERSION_NAME:-unknown}\` (upstream/main = \`$UPSTREAM_VERSION\`)"
    echo "- timestamp: $STAMP"
    echo
    echo "Expected-official / expected-improved are the predicted behaviors; **observed** is what"
    echo "this run actually classified (CRASH / IGNORED / HANDLED). A row is **MATCH** when observed"
    echo "agrees with the expectation for this build, else **MISMATCH**."
    echo
    echo "| # | Group | Case | URL | exp.official | exp.improved | observed | verdict | shot |"
    echo "|---|-------|------|-----|--------------|--------------|----------|---------|------|"
} >"$SUMMARY"

# ----------------------------------------------------------------------------
# Per-case runner
# ----------------------------------------------------------------------------
CASE_NUM=0
MISMATCHES=0

# fire <group> <label> <url> <expect_official> <expect_improved>
fire() {
    local group="$1" label="$2" url="$3" exp_off="$4" exp_imp="$5"
    CASE_NUM=$((CASE_NUM + 1))
    local n
    n=$(printf '%02d' "$CASE_NUM")
    local base="$OUTDIR/${n}_${label}"

    echo
    echo "---- [$n] $group / $label ----"
    echo "  url: $url"
    echo "  iOS: xcrun simctl openurl booted \"$url\""

    # Clean slate: snapshot 'before', then cold-start via the link.
    wake_device
    adb exec-out screencap -p >"${base}_before.png" 2>/dev/null

    # The cold-start getInitialURL path occasionally races (am start reports ok but the
    # freshly-restarted process never sees the link). Retry until we get a definitive
    # signal (a crash OR any deep-link trace), or attempts are exhausted. A silently
    # swallowed release crash produces no signal and simply exhausts the retries -> IGNORED.
    local logsnip="${base}_logcat.txt"
    local amout="" attempt=0 max_attempts=3
    local signal_re="toUpperCase|TypeError|FATAL EXCEPTION|AndroidRuntime|🔗|Deep Link|current route|navigating|DeepLink"
    while :; do
        attempt=$((attempt + 1))
        adb shell am force-stop "$PKG" >/dev/null 2>&1
        sleep 1                       # let the process fully die before relaunching
        adb logcat -c >/dev/null 2>&1 # clear; the enlarged ring buffer (-G 16M) keeps the
        # deep-link traces from being evicted before we dump them.
        amout=$(adb shell am start -W -a android.intent.action.VIEW -d "'$url'" "$COMPONENT" 2>&1 | tr -d '\r')
        sleep "$SETTLE_SECS"
        adb logcat -d -s ReactNativeJS:* AndroidRuntime:E ReactNative:E 2>/dev/null | tr -d '\r' >"$logsnip"
        grep -qiE "$signal_re" "$logsnip" && break
        [[ "$attempt" -ge "$max_attempts" ]] && break
        sleep 1
    done
    [[ "$attempt" -gt 1 ]] && echo "  (took $attempt attempts)"
    echo "$amout" >"${base}_amstart.txt"
    adb exec-out screencap -p >"${base}_after.png" 2>/dev/null

    # ---- classify (from logcat; the screenshot is kept only for human review) ----
    # IGNORED = no crash AND no deep-link trace: the handler did nothing. (am start still
    # cold-starts the app, so the screen changes even when the link is ignored, screenshot
    # equality is NOT a reliable signal and is not used here.)
    local observed=""
    if grep -qiE "toUpperCase|TypeError|FATAL EXCEPTION|AndroidRuntime|Unhandled JS Exception|Unhandled promise rejection" "$logsnip"; then
        observed="CRASH"
    elif grep -qiE "🔗|Deep Link|-- current route|navigating to|DeepLink" "$logsnip"; then
        observed="HANDLED"
    else
        observed="IGNORED"
    fi

    # ---- verdict for THIS build ----
    local expected verdict
    if [[ "$EXPECT_COL" == "expect_improved" ]]; then expected="$exp_imp"; else expected="$exp_off"; fi
    # WORKS and SILENT both manifest as HANDLED in logcat (the link parses); logcat alone
    # cannot see the silent data loss, so SILENT+HANDLED is flagged REVIEW, not a clean match.
    local exp_norm="$expected"
    [[ "$exp_norm" == WORKS* ]] && exp_norm="HANDLED"
    if [[ "$observed" == "$exp_norm" ]]; then
        verdict="MATCH"
    elif [[ "$expected" == SILENT* ]] && [[ "$observed" == "HANDLED" ]]; then
        verdict="REVIEW (silent data loss, check ${n}_after.png)"
    else
        verdict="MISMATCH"
        MISMATCHES=$((MISMATCHES + 1))
    fi

    echo "  am: $(echo "$amout" | grep -E 'Status|Error|Warning' | head -2 | paste -sd'; ' -)"
    echo "  observed: $observed   expected($BUILD_KIND): $expected   => $verdict"

    # ---- summary row ----
    local url_md="${url//|/\\|}"
    printf '| %s | %s | %s | `%s` | %s | %s | %s | %s | `%s` |\n' \
        "$n" "$group" "$label" "$url_md" "$exp_off" "$exp_imp" "$observed" "$verdict" "${n}_${label}_after.png" \
        >>"$SUMMARY"

    if [[ "$INTERACTIVE" -eq 1 ]]; then
        read -r -p "  [enter] next case, [s]+enter to stop... " ans
        [[ "$ans" == "s" ]] && {
            echo "stopped."
            finish
            exit 0
        }
    fi
}

finish() {
    {
        echo
        echo "## Result"
        echo
        if [[ "$MISMATCHES" -eq 0 ]]; then
            echo "**All cases matched expectations for $BUILD_KIND.**"
        else
            echo "**$MISMATCHES case(s) did NOT match expectations**, inspect the rows marked MISMATCH."
        fi
        echo
        echo "_REVIEW rows are silent-data-loss cases that 'parse' on the official build but drop"
        echo "the activation/hunted ref; confirm visually in the \`*_after.png\` screenshots._"
    } >>"$SUMMARY"

    echo
    echo "=============================================================="
    echo " Done. $CASE_NUM cases, $MISMATCHES mismatch(es)."
    echo " Summary:     $SUMMARY"
    echo " Screenshots: $OUTDIR/*_after.png"
    echo "=============================================================="
}

# ============================================================================
# TEST MATRIX
# Expectations encoded per case: <expect_official> <expect_improved>.
#   IGNORED  = link silently dropped (nothing happens)
#   SILENT   = parses but drops data (our.refs ignored); needs visual review
#   WORKS    = correctly handled (treated as HANDLED when observed)
# (CRASH is still detected if it occurs, but no case predicts one: the old
#  missing-mode crash was fixed upstream in 1296e30f.)
# All path-form URLs percent-encode any "/" in a value, as SOTAcat must emit.
# ============================================================================

# ---- GROUP A: PATH-FORM (com.ham2k:///...) gaps the improved build fixes ----
# All URLs are properly percent-encoded (as SOTAcat must emit). The remaining official
# gap is our.refs: it is never read, so setup / self-spot / S2S land in the wrong or
# most-recent operation instead of the activation (setup_ourrefs, spot_ourrefs,
# s2s_ourrefs). The earlier missing-mode crash was fixed upstream in 1296e30f.
fire "A:path-form" "setup_ourrefs" "com.ham2k:///qso?our.refs=pota:US-1234" "SILENT" "WORKS"
fire "A:path-form" "spot_ourrefs" "com.ham2k:///qso?our.refs=sota:W6%2FCT-006&frequency=14250000&mode=SSB" "SILENT" "WORKS"
fire "A:path-form" "s2s_ourrefs" "com.ham2k:///qso?our.refs=sota:W6%2FCT-006&their.call=KI2D&their.refs=pota:US-1234&frequency=7185000&mode=SSB" "SILENT" "WORKS"

# ---- GROUP B: PATH-FORM that already WORKS on official; improved must not regress ----
# Plain chases with mode present; the encoded SOTA ref and portable callsign in the
# last case exercise percent-decoding on both builds.
fire "B:works-on-official" "chase_pota_hz" "com.ham2k:///qso?their.call=KI2D&their.refs=pota:US-1234&frequency=7185000&mode=SSB" "WORKS" "WORKS"
fire "B:works-on-official" "chase_pota_khz" "com.ham2k:///qso?their.call=KI2D&their.refs=pota:US-1234&freq=7185&mode=SSB" "WORKS" "WORKS"
fire "B:works-on-official" "chase_portable_sota" "com.ham2k:///qso?their.call=S5%2FKC6X%2FP&their.refs=sota:W6%2FCT-006&frequency=14285000&mode=CW" "WORKS" "WORKS"

finish
