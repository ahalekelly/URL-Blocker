SHELL := /bin/zsh
.SHELLFLAGS := -eu -o pipefail -c

PROJECT := URLBlocker.xcodeproj
IOS_SCHEME := URLBlockerIOS
MACOS_SCHEME := URLBlockerMac

IOS_DERIVED_DATA ?= /tmp/urlblocker_ios_build
IOS_APP := $(IOS_DERIVED_DATA)/Build/Products/Release-iphoneos/URLBlockerIOS.app
IOS_DEVICE_SCRIPT := $(CURDIR)/scripts/connected-iphone.mjs
# App Store Connect API key that lets xcodebuild manage provisioning profiles. The .p8 stays outside Git.
ASC_KEY_ID ?= ZT4M83BNFY
ASC_ISSUER_ID ?= 1572e43c-4c24-4268-b52e-3f9460b87529
ASC_KEY_PATH ?= $(HOME)/.appstoreconnect/AuthKey_$(ASC_KEY_ID).p8
MACOS_DERIVED_DATA ?= /tmp/urlblocker_macos_build
MACOS_CODE_SIGN_IDENTITY ?= Apple Development
VIVALDI_APP ?= Vivaldi
VIVALDI_BINARY ?= /Applications/Vivaldi.app/Contents/MacOS/Vivaldi
BRAVE_APP ?= Brave Browser
BRAVE_BINARY ?= /Applications/Brave Browser.app/Contents/MacOS/Brave Browser
CHROME_EXTENSION_DIR := $(CURDIR)/build/chrome-extension

MACOS_BUILD_APP := $(MACOS_DERIVED_DATA)/Build/Products/Release/URLBlockerMac.app
MACOS_BUILD_EXTENSION := $(MACOS_BUILD_APP)/Contents/PlugIns/URLBlockerMacExtension.appex
MACOS_INSTALLED_APP := /Applications/URLBlockerMac.app
MACOS_INSTALLED_EXTENSION := $(MACOS_INSTALLED_APP)/Contents/PlugIns/URLBlockerMacExtension.appex
SAFARI_EXTENSION_ID := com.akelly.URLBlockerMac.Extension
SAFARI_EXTENSION_SDK := com.apple.Safari.web-extension
LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister
NPM = npm_config_script_shell="$(SHELL)" npm

.PHONY: help test all build check install chrome-extension vivaldi-install brave-install ios-build ios-build-unsigned ios-devices ios-install macos-build macos-install macos-clean-registration macos-verify macos-plugin-check

help:
	@printf "Targets:\n"
	@printf "  make test                    Run JavaScript tests.\n"
	@printf "  make chrome-extension        Build the unpacked Chrome extension in build/chrome-extension.\n"
	@printf "  make vivaldi-install         Build the Vivaldi extension; reload the running profile when open.\n"
	@printf "  make brave-install           Build the Brave extension; reload the running profile when open.\n"
	@printf "  make ios-build               Build the signed iOS device app.\n"
	@printf "  make ios-build-unsigned      Build the unsigned iOS device app.\n"
	@printf "  make ios-devices             List iOS devices available to Xcode.\n"
	@printf "  make ios-install             Build the signed app, then install it on the connected iPhone.\n"
	@printf "  make ios-install DEVICE=...  Build the signed app, then install it on a specific iPhone.\n"
	@printf "  make macos-build             Build the signed macOS app.\n"
	@printf "  make all                     Build iOS, macOS, and Chrome.\n"
	@printf "  make build                   Build iOS, macOS, and Chrome.\n"
	@printf "  make check                   Run tests, then build iOS, macOS, and Chrome.\n"
	@printf "  make install                 Install iOS, macOS, and Vivaldi in parallel.\n"
	@printf "  make macos-install           Build, install to /Applications, and verify Safari registration.\n"
	@printf "  make macos-plugin-check      Fail if Safari sees duplicate URL Blocker extensions.\n"

test:
	$(NPM) test

all: build

build: ios-build macos-build chrome-extension

check: test build

install:
	$(MAKE) -j3 ios-install macos-install vivaldi-install

chrome-extension:
	$(NPM) run build-chrome-extension

vivaldi-install:
	node scripts/install-chromium-extension.mjs --preflight "$(VIVALDI_APP)" "$(VIVALDI_BINARY)" "$(CHROME_EXTENSION_DIR)"
	$(NPM) run build-chrome-extension
	node scripts/install-chromium-extension.mjs "$(VIVALDI_APP)" "$(VIVALDI_BINARY)" "$(CHROME_EXTENSION_DIR)"

brave-install:
	node scripts/install-chromium-extension.mjs --preflight "$(BRAVE_APP)" "$(BRAVE_BINARY)" "$(CHROME_EXTENSION_DIR)"
	$(NPM) run build-chrome-extension
	node scripts/install-chromium-extension.mjs "$(BRAVE_APP)" "$(BRAVE_BINARY)" "$(CHROME_EXTENSION_DIR)"

ios-build:
	xcodebuild \
	  -quiet \
	  -hideShellScriptEnvironment \
	  -project "$(PROJECT)" \
	  -scheme "$(IOS_SCHEME)" \
	  -configuration Release \
	  -sdk iphoneos \
	  -destination generic/platform=iOS \
	  -derivedDataPath "$(IOS_DERIVED_DATA)" \
	  -allowProvisioningUpdates \
	  -authenticationKeyPath "$(ASC_KEY_PATH)" \
	  -authenticationKeyID "$(ASC_KEY_ID)" \
	  -authenticationKeyIssuerID "$(ASC_ISSUER_ID)" \
	  COMPILATION_CACHE_ENABLE_CACHING=YES \
	  build

ios-build-unsigned:
	xcodebuild \
	  -quiet \
	  -hideShellScriptEnvironment \
	  -project "$(PROJECT)" \
	  -scheme "$(IOS_SCHEME)" \
	  -configuration Release \
	  -sdk iphoneos \
	  -destination generic/platform=iOS \
	  -derivedDataPath "$(IOS_DERIVED_DATA)" \
	  CODE_SIGNING_ALLOWED=NO \
	  COMPILATION_CACHE_ENABLE_CACHING=YES \
	  build

ios-devices:
	xcrun devicectl list devices

ios-install: ios-build
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
	printf "Installing %s on %s\n" "$(IOS_APP)" "$$device"; \
	xcrun devicectl device install app --device "$$device" "$(IOS_APP)"

macos-build:
	xcodebuild \
	  -quiet \
	  -hideShellScriptEnvironment \
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
	codesign --verify --strict --deep "$(MACOS_INSTALLED_APP)"
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
