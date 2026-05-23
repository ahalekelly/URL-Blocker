SHELL := /bin/zsh
.SHELLFLAGS := -eu -o pipefail -c

PROJECT := URLBlocker.xcodeproj
IOS_SCHEME := URLBlockerIOS
MACOS_SCHEME := URLBlockerMac

IOS_DERIVED_DATA ?= /tmp/urlblocker_ios_build
IOS_SIGNED_IPA ?= $(CURDIR)/build/URLBlockerIOS-signed.ipa
IOS_DEVICE_SCRIPT := $(CURDIR)/scripts/connected-iphone.mjs
IOS_SIGNING_ASSETS ?= $(HOME)/Documents/UDIDRegistrations/iOSSigning
IOS_SIGNING_DERIVED_DATA ?= /tmp/urlblocker_signing_build
IOS_SIGNING_SCRIPT := $(CURDIR)/scripts/sign-ios-udid.mjs
IOS_SIGNING_WORK_DIR ?= /tmp/urlblocker_signing
IOS_SIGNED_DIR ?= /tmp/urlblocker_signed
IOS_APP_GROUP ?= group.d944b664533a4c2f.1
P12_PASSWORD_FILE ?= $(IOS_SIGNING_ASSETS)/Development.p12.password
MACOS_DERIVED_DATA ?= /tmp/urlblocker_macos_build
MACOS_CODE_SIGN_IDENTITY ?= Apple Development
VIVALDI_APP ?= Vivaldi
BRAVE_APP ?= Brave Browser
CHROME_EXTENSION_DIR := $(CURDIR)/build/chrome-extension

MACOS_BUILD_APP := $(MACOS_DERIVED_DATA)/Build/Products/Release/URLBlockerMac.app
MACOS_BUILD_EXTENSION := $(MACOS_BUILD_APP)/Contents/PlugIns/URLBlockerMacExtension.appex
MACOS_INSTALLED_APP := /Applications/URLBlockerMac.app
MACOS_INSTALLED_EXTENSION := $(MACOS_INSTALLED_APP)/Contents/PlugIns/URLBlockerMacExtension.appex
SAFARI_EXTENSION_ID := com.akelly.URLBlockerMac.Extension
SAFARI_EXTENSION_SDK := com.apple.Safari.web-extension
LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister

.PHONY: help test all build check chrome-extension vivaldi-install brave-install ios-build ios-build-unsigned ios-signed-ipa ios-devices ios-install macos-build macos-install macos-clean-registration macos-verify macos-plugin-check

help:
	@printf "Targets:\n"
	@printf "  make test                    Run JavaScript tests.\n"
	@printf "  make chrome-extension        Build the unpacked Chrome extension in build/chrome-extension.\n"
	@printf "  make vivaldi-install         Build and launch Vivaldi with the extension loaded.\n"
	@printf "  make brave-install           Build and launch Brave with the extension loaded.\n"
	@printf "  make ios-build               Build build/URLBlockerIOS-signed.ipa with UDID Registrations signing.\n"
	@printf "  make ios-build-unsigned      Build the unsigned iOS device app.\n"
	@printf "  make ios-signed-ipa          Alias for make ios-build.\n"
	@printf "  make ios-devices             List iOS devices available to Xcode.\n"
	@printf "  make ios-install             Build the signed IPA, then install it on the connected iPhone.\n"
	@printf "  make ios-install DEVICE=...  Build the signed IPA, then install it on a specific iPhone.\n"
	@printf "  make macos-build             Build the signed macOS app.\n"
	@printf "  make all                     Build iOS, macOS, and Chrome.\n"
	@printf "  make build                   Build iOS, macOS, and Chrome.\n"
	@printf "  make check                   Run tests, then build iOS, macOS, and Chrome.\n"
	@printf "  make macos-install           Build, install to /Applications, and verify Safari registration.\n"
	@printf "  make macos-plugin-check      Fail if Safari sees duplicate URL Blocker extensions.\n"

test:
	npm test

all: build

build: ios-build macos-build chrome-extension

check: test build

chrome-extension:
	npm run build-chrome-extension

vivaldi-install: chrome-extension
	@if pgrep -x "$(VIVALDI_APP)" >/dev/null; then \
	  printf "%s is already running. Quit it, then rerun make vivaldi-install so --load-extension applies at startup.\n" "$(VIVALDI_APP)" >&2; \
	  exit 1; \
	fi
	@printf "Opening %s with URL Blocker loaded from %s\n" "$(VIVALDI_APP)" "$(CHROME_EXTENSION_DIR)"
	open -na "$(VIVALDI_APP)" --args \
	  --load-extension="$(CHROME_EXTENSION_DIR)" \
	  chrome://extensions

brave-install: chrome-extension
	@if pgrep -x "$(BRAVE_APP)" >/dev/null; then \
	  printf "%s is already running. Quit it, then rerun make brave-install so --load-extension applies at startup.\n" "$(BRAVE_APP)" >&2; \
	  exit 1; \
	fi
	@printf "Opening %s with URL Blocker loaded from %s\n" "$(BRAVE_APP)" "$(CHROME_EXTENSION_DIR)"
	open -na "$(BRAVE_APP)" --args \
	  --load-extension="$(CHROME_EXTENSION_DIR)" \
	  chrome://extensions

ios-build:
	IOS_APP_GROUP="$(IOS_APP_GROUP)" \
	IOS_PROJECT="$(PROJECT)" \
	IOS_SCHEME="$(IOS_SCHEME)" \
	IOS_SIGNED_DIR="$(IOS_SIGNED_DIR)" \
	IOS_SIGNED_IPA="$(IOS_SIGNED_IPA)" \
	IOS_SIGNING_ASSETS="$(IOS_SIGNING_ASSETS)" \
	IOS_SIGNING_DERIVED_DATA="$(IOS_SIGNING_DERIVED_DATA)" \
	IOS_SIGNING_WORK_DIR="$(IOS_SIGNING_WORK_DIR)" \
	P12_PASSWORD_FILE="$(P12_PASSWORD_FILE)" \
	node "$(IOS_SIGNING_SCRIPT)"

ios-build-unsigned:
	xcodebuild \
	  -project "$(PROJECT)" \
	  -scheme "$(IOS_SCHEME)" \
	  -configuration Release \
	  -sdk iphoneos \
	  -destination generic/platform=iOS \
	  -derivedDataPath "$(IOS_DERIVED_DATA)" \
	  CODE_SIGNING_ALLOWED=NO \
	  COMPILATION_CACHE_ENABLE_CACHING=YES \
	  build

ios-signed-ipa: ios-build

ios-devices:
	xcrun devicectl list devices

ios-install: ios-build
	@if [[ ! -f "$(IOS_SIGNED_IPA)" ]]; then \
	  printf "Missing signed IPA: %s\n" "$(IOS_SIGNED_IPA)" >&2; \
	  exit 1; \
	fi
	@device="$(DEVICE)"; \
	if [[ -z "$$device" ]]; then \
	  device_file=$$(mktemp /tmp/urlblocker_ios_device.XXXXXX); \
	  if ! node "$(IOS_DEVICE_SCRIPT)" > "$$device_file"; then \
	    exit 1; \
	  fi; \
	  read -r device < "$$device_file"; \
	fi; \
	if [[ -z "$$device" ]]; then \
	  printf "No iPhone selected. Connect and trust one iPhone, or pass DEVICE=...\n" >&2; \
	  exit 1; \
	fi; \
	printf "Installing %s on %s\n" "$(IOS_SIGNED_IPA)" "$$device"; \
	install_dir=$$(mktemp -d /tmp/urlblocker_ios_install.XXXXXX); \
	unzip -q "$(IOS_SIGNED_IPA)" -d "$$install_dir"; \
	xcrun devicectl device install app --device "$$device" "$$install_dir/Payload/URLBlockerIOS.app"

macos-build:
	xcodebuild \
	  -project "$(PROJECT)" \
	  -scheme "$(MACOS_SCHEME)" \
	  -configuration Release \
	  -sdk macosx \
	  -destination generic/platform=macOS \
	  -derivedDataPath "$(MACOS_DERIVED_DATA)" \
	  COMPILATION_CACHE_ENABLE_CACHING=YES \
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
