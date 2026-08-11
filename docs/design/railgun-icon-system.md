# Railgun icon system

The Railgun mark is an abstract rail/orbit: two interrupted orbital rails frame a forward beam,
while the amber signal segment provides a stable point of recognition. It communicates motion and
precision without depicting a literal weapon, projectile, or explosion.

## Sources and packaged assets

- `apps/desktop/build/source/RailgunIconMaster.svg`: editable full-color construction master.
- `apps/desktop/build/source/RailgunIconMaster-Monochrome.svg`: editable single-color master.
- `apps/desktop/build/icon.png`: canonical 1024 × 1024 Electron Builder source.
- `apps/desktop/resources/icon.png`: development Dock icon used by Electron.

Electron Builder derives the packaged macOS icon from `build/icon.png`. The source SVGs are retained
for future exports and must keep the same geometry and safe area as the production raster.

## Construction

- Canvas: 1024 × 1024 points/pixels.
- Icon tile: 896 × 896, inset 64, with a 224 radius.
- Safe area: the principal mark stays within the 64-point inset.
- Primary geometry: 52-point orbital rails, a 44-point beam body, and a 16-point highlight.
- Palette: graphite `#0B1220`, cyan `#22D3EE`, amber `#FBBF24`, and rail `#64748B`.

The graphite tile and high-contrast beam remain legible in light and dark appearances. The
monochrome master removes color dependence while preserving the silhouette. Recognition must not
depend on text, fine texture, shadow, or detail that disappears at small sizes.

Review exports at 16, 32, 64, 128, 256, 512, and 1024 pixels after changing the master or raster.
