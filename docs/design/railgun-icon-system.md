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
- `apps/macos/Resources/RailgunIcon/RailgunIcon-1024.svg` — production vector
  source with the canonical 1024 × 1024 canvas.
- `apps/macos/Resources/RailgunIcon/RailgunIcon-1024.png` — 1024 × 1024 raster
  export from the production vector source.

The AppIcon asset catalog and generated-size wiring are intentionally deferred
to SWFT-008. The source files are kept outside the generated Xcode project so
they remain editable and can be consumed by that catalog without duplicating
the artwork.

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

`RailgunIcon-1024.svg` is the canonical production geometry source. When the
geometry changes, update both editable masters and the production source in the
same change; variants may change appearance values, but not the rail, wedge,
beam, aperture, ring, or registration geometry. The PNG is an export, not a
second design. The `testMonochromeMasterPreservesProductionSilhouette` XCTest
guards the monochrome/production geometry invariant.

Any later AppIcon sizes must be generated from the production source and
reviewed at 16, 32, 64, 128, 256, 512, and 1024 pixels. SWFT-008 owns that
generation and validation.
