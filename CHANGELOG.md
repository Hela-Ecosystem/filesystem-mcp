## [3.0.3] - 2026-11-18

### Fixed
- Keep advertised MCP and HTTP server versions in sync with package metadata through a single-source version guard.

# Changelog

All notable changes to this project.

## [3.0.4] - 2026-11-19

### Changed
- npm audit fix clears seven advisories. Three remain and need breaking majors (zod 3 to 4, glob 10 to 14); tracked separately.

## [3.0.2] - 2026-11-18

### Security
- Do not follow symlinks while listing, finding, or searching within a workspace root.
- Add edge-case coverage for symlink escapes, archive expansion, watcher cleanup, and large file handling.

## [3.0.1] - 2026-11-13

### Fixed
- Replaced Unix-only cleanup with the portable Node maintenance runner.
- Accumulated recursive directory sizes correctly.

### Changed
- Declared the distributed server under GPL-3.0-or-later and synchronized documentation.

## [3.0.0] - 2026-10-31

### Changed
- **Version reset to 3.0.0** — per-server version metadata baseline reset (Phase 7). All `package.json`, MCP `ServerInfo.version`, and HTTP metadata now report `3.0.0`. This is a metadata/interface baseline reset; for `hela-plastid` it is not an upgrade from the previous `4.2.0` advert.

