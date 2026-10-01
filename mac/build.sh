#!/bin/bash
# Builds Voicenotes.app (universal: Apple Silicon + Intel) on macOS. Output: mac/build/Voicenotes.zip
set -euo pipefail
cd "$(dirname "$0")"
rm -rf build && mkdir -p build
APP=build/Voicenotes.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"

for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13.0" -o "build/Voicenotes-$arch" Sources/*.swift
done
lipo -create build/Voicenotes-arm64 build/Voicenotes-x86_64 -output "$APP/Contents/MacOS/Voicenotes"

# App icon from the web app's SVG-rendered PNG.
ICONSET=build/AppIcon.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size ../public/icon-512.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) ../public/icon-512.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature: required to run on Apple Silicon; not notarized, so macOS asks once.
codesign --force --deep --sign - "$APP"
(cd build && ditto -c -k --keepParent Voicenotes.app Voicenotes.zip)
echo "Built mac/build/Voicenotes.zip"
