# Railgun native icon system

SWFT-007 establishes the permanent RailgunX mark used by the native macOS
client. The mark is an abstract rail/orbit: two interrupted orbital rails frame
a forward beam, while the amber signal segment provides a small, stable point
of recognition. It communicates motion and precision without depicting a
literal weapon, projectile, or explosion.

## Deliverables

- `apps/macos/Resources/RailgunIcon/RailgunIconMaster.svg` — editable full-color
  construction master.
- `apps/macos/Resources/RailgunIcon/RailgunIconMaster-Monochrome.svg` — editable
  single-color master for system surfaces that require a monochrome mark.
- `apps/macos/Resources/RailgunIcon/RailgunIcon-1024.png` — canonical 1024 ×
  1024 AppIcon artwork, cropped from the supplied reference with transparent
  outside corners.
- `apps/macos/Resources/RailgunIcon/RailgunIcon-1024.svg` — retained editable
  vector fallback; the AppIcon catalog is generated from the PNG above.
- `apps/macos/Resources/Assets.xcassets/AppIcon.appiconset` — checked-in
  1×/2× macOS AppIcon representations generated from the raster export.
- `apps/desktop/assets/railgun-icon.png` and
  `apps/desktop/assets/railgun-icon.icns` — the Electron package artwork used
  by the desktop About window and macOS application bundle.

The artwork source remains outside the generated Xcode project so it remains
reusable without duplicating the artwork. Run
`apps/macos/scripts/generate-app-icon-assets.sh` after changing the production
PNG, then run `apps/macos/scripts/validate-app-icon-assets.sh` to verify all
required sizes and the compiled bundle.

## Construction

- Canvas: 1024 × 1024 points/pixels.
- Icon tile: 896 × 896, inset 64, with a 224 radius. macOS applies its own
  platform mask on top of this generous source shape.
- Safe area: the principal mark stays within the 64-point inset.
- Primary geometry: the two orbital rails are 52 points wide; the beam has a
  44-point body and a 16-point highlight.
- Full-color palette: graphite `#0B1220`, cyan beam `#22D3EE`, amber signal
  `#FBBF24`, and neutral rail `#64748B`.

The graphite tile and high-contrast beam are stable in both light and dark
system appearances. The monochrome master removes color dependence while
preserving the same silhouette and safe area. There is no text, fine texture,
shadow, or detail that is required for recognition at small sizes.

## Source-of-truth rules

`RailgunIcon-1024.png` is the canonical shipped artwork. The SVG masters are
kept as an editable fallback and are not used to generate the AppIcon catalog.
The `testMonochromeMasterPreservesProductionSilhouette` XCTest continues to
guard their shared fallback silhouette. The desktop PNG is kept byte-for-byte
in sync with this source; its ICNS companion contains the same artwork at the
macOS icon sizes.

AppIcon representations are generated from the production source and reviewed
at 16, 32, 64, 128, 256, 512, and 1024 pixels. The compiled bundle must expose
`CFBundleIconName = AppIcon`; macOS then uses the same bundle icon for the
Dock, Finder, About surfaces, and notifications.
