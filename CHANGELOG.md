## [3.0.6] - 2026-11-22

### Fixed
- `read_file` takes byte ranges, so a `limit` or `offset` that landed mid-character produced U+FFFD and lost the character for good; paging a non-ASCII file corrupted one at every boundary. Text encodings now snap both ends to character boundaries and return `startByte`/`endByte` plus the byte range actually consumed, so a caller can resume losslessly. (`filesystem-mcp#25`)
- `extract_archive` reports every entry. Path-traversal entries were already rejected but silently, so a partial extraction reported plain success and the archive's suspicious content was never surfaced. The response now carries `extracted` (count), `entries`, and `skipped` with a reason per entry. (`filesystem-mcp#26`)
- `watch_file` can deliver events. They were collected into a local array that was discarded on return, so a watcher consumed a handle and reported `events: []` forever. Events are buffered per path, a repeat `watch_file` call returns what accumulated since the previous call, `stop_watching` returns the remainder, and the tool now waits for chokidar's initial scan before reporting success — writes in that window were previously missed. (`filesystem-mcp#27`)
- `compare_files` reports `size` in bytes like every other tool, adds `characters` for the code-unit count, and counts lines without treating a trailing newline as an extra empty line. (`filesystem-mcp#28`)

## [3.0.3] - 2026-11-18

### Fixed
- Keep advertised MCP and HTTP server versions in sync with package metadata through a single-source version guard.

# Changelog

All notable changes to this project.

## [3.0.5] - 2026-11-19

### Changed
- Upgrade Zod to 4.6 and glob to 14, preserving file search and discovery behavior.

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

