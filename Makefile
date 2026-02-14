.PHONY: build start apk install bundle clean devices help

BUNDLE := android/app/src/main/assets/index.android.bundle
APK_DIR := android/app/build/outputs/apk/debugOptimized

# Default target
help:
	@echo "Available targets:"
	@echo ""
	@echo "  Interactive development (requires Metro):"
	@echo "    start        - Start Metro dev server"
	@echo "    build        - Build + install debug APK (needs Metro running)"
	@echo ""
	@echo "  Standalone APK (for field testing without USB):"
	@echo "    apk          - Bundle JS from source and build standalone APK"
	@echo "    install      - Install last-built standalone APK to device"
	@echo ""
	@echo "  Utility:"
	@echo "    bundle       - Regenerate JS bundle from current source"
	@echo "    clean        - Remove all build artifacts and stale JS bundle"
	@echo "    devices      - List connected adb devices"

# --- Interactive development ---

# Start Metro dev server
start:
	npx react-native start

# Build + install debug APK (requires Metro running)
build:
	cd android && ./gradlew installDebug

# --- Standalone APK ---

# Bundle JS then build standalone APK; print path on success
apk: bundle
	cd android && ./gradlew assembleDebugOptimized
	@echo ""
	@echo "APK: $$(ls $(APK_DIR)/*.apk 2>/dev/null)"

# Install standalone APK to device (run 'make apk' first)
install:
	cd android && ./gradlew installDebugOptimized

# --- Utility ---

# Regenerate JS bundle from current source
bundle:
	rm -f $(BUNDLE)
	npx react-native bundle --platform android --dev false --entry-file index.js \
		--bundle-output $(BUNDLE) \
		--assets-dest android/app/src/main/res/

# Remove all build artifacts and stale JS bundle
clean:
	cd android && ./gradlew clean
	rm -f $(BUNDLE)

# List connected devices
devices:
	adb devices
