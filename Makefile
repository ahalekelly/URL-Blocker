SHELL := /bin/zsh
.SHELLFLAGS := -eu -o pipefail -c

PROJECT := URLBlocker.xcodeproj
IOS_SCHEME := URLBlockerIOS
MACOS_SCHEME := URLBlockerMac

IOS_DERIVED_DATA ?= /tmp/urlblocker_ios_build
MACOS_DERIVED_DATA ?= /tmp/urlblocker_macos_build
MACOS_CODE_SIGN_IDENTITY ?= Apple Development

MACOS_BUILD_APP := $(MACOS_DERIVED_DATA)/Build/Products/Release/URLBlockerMac.app
MACOS_BUILD_EXTENSION := $(MACOS_BUILD_APP)/Contents/PlugIns/URLBlockerMacExtension.appex
MACOS_INSTALLED_APP := /Applications/URLBlockerMac.app
MACOS_INSTALLED_EXTENSION := $(MACOS_INSTALLED_APP)/Contents/PlugIns/URLBlockerMacExtension.appex
SAFARI_EXTENSION_ID := com.akelly.URLBlockerMac.Extension
SAFARI_EXTENSION_SDK := com.apple.Safari.web-extension
LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister

.PHONY: help test build both check ios-build macos-build macos-install macos-clean-registration macos-verify macos-plugin-check

help:
	@printf "Targets:\n"
	@printf "  make test                    Run JavaScript tests.\n"
	@printf "  make ios-build               Build the unsigned iOS device app.\n"
	@printf "  make macos-build             Build the signed macOS app.\n"
	@printf "  make build                   Build iOS and macOS.\n"
	@printf "  make check                   Run tests, then build iOS and macOS.\n"
	@printf "  make macos-install           Build, install to /Applications, and verify Safari registration.\n"
	@printf "  make macos-plugin-check      Fail if Safari sees duplicate URL Blocker extensions.\n"

test:
	npm test

build: ios-build macos-build

both: build

check: test build

ios-build:
	xcodebuild \
	  -project "$(PROJECT)" \
	  -scheme "$(IOS_SCHEME)" \
	  -configuration Release \
	  -sdk iphoneos \
	  -destination generic/platform=iOS \
	  -derivedDataPath "$(IOS_DERIVED_DATA)" \
	  CODE_SIGNING_ALLOWED=NO \
	  COMPILATION_CACHE_ENABLE_CACHING=NO \
	  build

macos-build:
	xcodebuild \
	  -project "$(PROJECT)" \
	  -scheme "$(MACOS_SCHEME)" \
	  -configuration Release \
	  -sdk macosx \
	  -destination generic/platform=macOS \
	  -derivedDataPath "$(MACOS_DERIVED_DATA)" \
	  COMPILATION_CACHE_ENABLE_CACHING=NO \
	  CODE_SIGN_IDENTITY="$(MACOS_CODE_SIGN_IDENTITY)" \
	  build
	$(MAKE) macos-clean-registration

macos-install: macos-build
	ditto "$(MACOS_BUILD_APP)" "$(MACOS_INSTALLED_APP)"
	"$(LSREGISTER)" -f -R -trusted "$(MACOS_INSTALLED_APP)"
	$(MAKE) macos-verify

macos-clean-registration:
	if [[ -d "$(MACOS_BUILD_EXTENSION)" ]]; then \
	  pluginkit -r "$(MACOS_BUILD_EXTENSION)" || true; \
	fi
	if [[ -d "$(MACOS_BUILD_APP)" ]]; then \
	  "$(LSREGISTER)" -u "$(MACOS_BUILD_APP)" 2>/dev/null || true; \
	fi

macos-verify:
	codesign --verify --strict --deep --verbose=4 "$(MACOS_INSTALLED_APP)"
	$(MAKE) macos-plugin-check

macos-plugin-check:
	@output=$$(pluginkit -m -A -D -vvv -p "$(SAFARI_EXTENSION_SDK)"); \
	printf "%s\n" "$$output"; \
	count=$$(printf "%s\n" "$$output" | grep -c "$(SAFARI_EXTENSION_ID)" || true); \
	if [[ "$$count" -ne 1 ]]; then \
	  printf "Expected exactly one %s registration, found %s.\n" "$(SAFARI_EXTENSION_ID)" "$$count" >&2; \
	  exit 1; \
	fi; \
	if ! printf "%s\n" "$$output" | grep -q "Path = $(MACOS_INSTALLED_EXTENSION)"; then \
	  printf "Expected Safari registration to point at %s.\n" "$(MACOS_INSTALLED_EXTENSION)" >&2; \
	  exit 1; \
	fi
