import { promises as fs } from 'fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { globIterate, type GlobOptions } from 'glob';
import type { Stats } from 'fs';
import archiver from 'archiver';
import chokidar from 'chokidar';
import { SearchInFilesSchema, WatchFileSchema, CompareFilesSchema, ArchiveFilesSchema } from './types.js';
import type { FileOperationResult, SearchInFilesArgs, WatchFileArgs, CompareFilesArgs, ArchiveFilesArgs, SearchResult, FileWatchEvent } from './types.js';
import { FileOperations } from './file-operations.js';

/**
 * Advanced operations for the FileSystem MCP Server
 */
export class AdvancedOperations {
  private static watchers = new Map<string, chokidar.FSWatcher>();
  private static watchBuffers = new Map<string, FileWatchEvent[]>();

  /**
   * Search for text patterns in files
   */
  static async searchInFiles(args: SearchInFilesArgs): Promise<FileOperationResult> {
    try {
      const {
        pattern,
        directory = '.',
        filePattern,
        maxDepth,
        includeHidden = false,
        caseSensitive = false,
        wholeWord = false,
        contextLines = 2
      } = SearchInFilesSchema.parse(args);

      const resolvedDir = resolve(directory);
      const results: SearchResult[] = [];

      // Build file pattern for glob
      const searchPattern = filePattern || '**/*';
      const globOptions: GlobOptions = {
        cwd: resolvedDir,
        dot: includeHidden,
        nocase: !caseSensitive
      };

      let globPattern = searchPattern;
      if (maxDepth !== undefined) {
        const depthPattern = maxDepth === 1 ? '' : '/*'.repeat(maxDepth - 1);
        globPattern = join(searchPattern, depthPattern);
      }

      const files: string[] = [];
      for await (const file of globIterate(globPattern, globOptions)) {
        files.push(String(file));
      }

      // Create regex pattern
      let regexPattern = pattern;
      if (wholeWord) {
        regexPattern = `\\b${regexPattern}\\b`;
      }
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(regexPattern, flags);

      // Search in each file
      for (const file of files) {
        try {
          const fullPath = join(resolvedDir, String(file));
          if ((await fs.lstat(fullPath)).isSymbolicLink()) continue;
          const fileInfo = await FileOperations.getFileInfo({ path: fullPath, followSymlinks: true });
          
          if (!fileInfo.success || !fileInfo.data?.isFile) {
            continue;
          }

          const content = await fs.readFile(fullPath, 'utf8');
          const lines = content.split('\n');
          const matches: SearchResult['matches'] = [];

          // Search for matches
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(line)) !== null) {
              const startLine = Math.max(0, i - contextLines);
              const endLine = Math.min(lines.length - 1, i + contextLines);
              const context = lines.slice(startLine, endLine + 1).join('\n');

              matches.push({
                line: i + 1,
                column: match.index + 1,
                text: match[0],
                context: context
              });
            }
            regex.lastIndex = 0; // Reset regex for next line
          }

          if (matches.length > 0) {
            results.push({
              path: fullPath,
              matches,
              fileInfo: fileInfo.data
            });
          }
        } catch {
          // Skip files that can't be read
        }
      }

      return {
        success: true,
        message: `Search completed: ${results.length} files with matches`,
        path: directory,
        data: {
          results,
          totalMatches: results.reduce((sum, result) => sum + result.matches.length, 0),
          pattern,
          directory: resolvedDir
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to search in files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        path: args.directory || '.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Watch file or directory for changes
   */
  static async watchFile(args: WatchFileArgs): Promise<FileOperationResult> {
    try {
      const { path, recursive = false, ignoreInitial = true, ignored } = WatchFileSchema.parse(args);

      // Check if path exists
      await fs.access(path);

      // A repeat call is how a caller collects events: return what the existing
      // watcher has buffered instead of restarting it and losing them
      // (filesystem-mcp#27).
      if (this.watchers.has(path)) {
        return {
          success: true,
          message: 'Watching already active; returning buffered events',
          path,
          data: {
            watching: true,
            recursive,
            ignoreInitial,
            events: this.drainWatchEvents(path),
          },
        };
      }

      const watcher = chokidar.watch(path, {
        ignored: ignored || /(^|[\\/])\../, // ignore dotfiles by default
        persistent: true,
        ignoreInitial,
        followSymlinks: false,
        depth: recursive ? undefined : 0
      });

      this.watchers.set(path, watcher);

      const push = (event: FileWatchEvent) => {
        const buffered = this.watchBuffers.get(path) ?? [];
        buffered.push(event);
        if (buffered.length > 500) buffered.splice(0, buffered.length - 500);
        this.watchBuffers.set(path, buffered);
      };

      watcher
        .on('add', (filePath, stats) => {
          push({
            type: 'add',
            path: filePath,
            stats: stats ? this.statsToFileInfo(filePath, stats) : undefined
          });
        })
        .on('change', (filePath, stats) => {
          push({
            type: 'change',
            path: filePath,
            stats: stats ? this.statsToFileInfo(filePath, stats) : undefined
          });
        })
        .on('unlink', (filePath) => {
          push({
            type: 'unlink',
            path: filePath
          });
        })
        .on('addDir', (dirPath, stats) => {
          push({
            type: 'addDir',
            path: dirPath,
            stats: stats ? this.statsToFileInfo(dirPath, stats) : undefined
          });
        })
        .on('unlinkDir', (dirPath) => {
          push({
            type: 'unlinkDir',
            path: dirPath
          });
        })
        .on('error', (error) => {
          console.error('Watcher error:', error);
        });

      // Do not report "watching" before chokidar has completed its initial scan:
      // a write in that window is missed, which is exactly the silent-no-events
      // failure this tool was reported for.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        watcher.once('ready', () => { clearTimeout(timer); resolve(); });
      });

      return {
        success: true,
        message: 'File watching started successfully',
        path,
        data: {
          watching: true,
          recursive,
          ignoreInitial,
          // Empty on start; poll with another watch_file call to collect new events.
          events: this.drainWatchEvents(path),
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to start watching: ${error instanceof Error ? error.message : 'Unknown error'}`,
        path: args.path,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /** Take and clear the buffered events for one watched path. */
  private static drainWatchEvents(path: string): FileWatchEvent[] {
    const buffered = this.watchBuffers.get(path) ?? [];
    this.watchBuffers.set(path, []);
    return buffered;
  }

  /**
   * Stop watching a file or directory
   */
  static async stopWatching(path: string): Promise<FileOperationResult> {
    try {
      const watcher = this.watchers.get(path);
      if (watcher) {
        await watcher.close();
        this.watchers.delete(path);
        const events = this.drainWatchEvents(path);
        this.watchBuffers.delete(path);
        return {
          success: true,
          message: 'Watching stopped successfully',
          path,
          data: { watching: false, events }
        };
      } else {
        return {
          success: false,
          message: 'No active watcher found for path',
          path,
          error: 'Watcher not found'
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to stop watching: ${error instanceof Error ? error.message : 'Unknown error'}`,
        path,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Compare two files
   */
  static async compareFiles(args: CompareFilesArgs): Promise<FileOperationResult> {
    try {
      const { file1, file2, ignoreWhitespace = false, ignoreCase = false } = CompareFilesSchema.parse(args);

      // Check if both files exist
      await fs.access(file1);
      await fs.access(file2);

      const content1 = await fs.readFile(file1, 'utf8');
      const content2 = await fs.readFile(file2, 'utf8');

      let processedContent1 = content1;
      let processedContent2 = content2;

      if (ignoreWhitespace) {
        processedContent1 = content1.replace(/\s+/g, ' ').trim();
        processedContent2 = content2.replace(/\s+/g, ' ').trim();
      }

      if (ignoreCase) {
        processedContent1 = processedContent1.toLowerCase();
        processedContent2 = processedContent2.toLowerCase();
      }

      // A trailing newline does not start a new line; split() counts one extra empty
      // segment (filesystem-mcp#28).
      const splitLines = (text: string): string[] => {
        const parts = text.split('\n');
        if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
        return parts;
      };
      const lines1 = splitLines(processedContent1);
      const lines2 = splitLines(processedContent2);

      const differences: Array<{
        line: number;
        type: 'added' | 'removed' | 'modified';
        content: string;
      }> = [];

      const maxLines = Math.max(lines1.length, lines2.length);
      for (let i = 0; i < maxLines; i++) {
        const line1 = lines1[i] || '';
        const line2 = lines2[i] || '';

        if (line1 !== line2) {
          if (i >= lines1.length) {
            differences.push({ line: i + 1, type: 'added', content: line2 });
          } else if (i >= lines2.length) {
            differences.push({ line: i + 1, type: 'removed', content: line1 });
          } else {
            differences.push({ line: i + 1, type: 'modified', content: `- ${line1}\n+ ${line2}` });
          }
        }
      }

      const identical = differences.length === 0;

      return {
        success: true,
        message: identical ? 'Files are identical' : `Files differ: ${differences.length} differences found`,
        path: file1,
        data: {
          identical,
          differences,
          totalDifferences: differences.length,
          // `size` is bytes everywhere else in this cell; characters get their own field.
          file1: { path: file1, lines: lines1.length, size: Buffer.byteLength(content1, 'utf8'), characters: content1.length },
          file2: { path: file2, lines: lines2.length, size: Buffer.byteLength(content2, 'utf8'), characters: content2.length },
          options: { ignoreWhitespace, ignoreCase }
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to compare files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        path: args.file1,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create archive from files
   */
  static async archiveFiles(args: ArchiveFilesArgs): Promise<FileOperationResult> {
    try {
      const {
        files,
        archivePath,
        format = 'zip',
        compressionLevel = 6
      } = ArchiveFilesSchema.parse(args);

      // Check if all source files exist
      for (const file of files) {
        await fs.access(file);
      }

      // Create archive
      const archiveFormat = format === 'gzip' ? 'tar' : format;
      const archive = archiver(archiveFormat, {
        ...(format === 'gzip' ? { gzip: true } : {}),
        zlib: { level: compressionLevel }
      });

      const { createWriteStream } = await import('fs');
      const output = createWriteStream(archivePath);
      archive.pipe(output);

      // Add files to archive
      for (const file of files) {
        const stats = await fs.stat(file);
        if (stats.isDirectory()) {
          archive.directory(file, file);
        } else {
          archive.file(file, { name: file });
        }
      }

      await archive.finalize();

      // Wait for archive to complete
      await new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve());
        output.on('error', reject);
      });

      const archiveStats = await fs.stat(archivePath);

      return {
        success: true,
        message: 'Archive created successfully',
        path: archivePath,
        data: {
          archivePath,
          format,
          compressionLevel,
          size: archiveStats.size,
          filesCount: files.length,
          humanReadable: this.formatBytes(archiveStats.size)
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to create archive: ${error instanceof Error ? error.message : 'Unknown error'}`,
        path: args.archivePath,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Extract archive
   */
  static async extractArchive(archivePath: string, destination: string): Promise<FileOperationResult> {
    try {
      await fs.access(archivePath);
      await fs.mkdir(destination, { recursive: true });

      const unzipper = await import('unzipper');
      const directory = await unzipper.Open.file(archivePath);
      const root = resolve(destination);
      const rootPrefix = root.endsWith(sep) ? root : root + sep;

      const entries: string[] = [];
      const skipped: Array<{ entry: string; reason: string }> = [];

      for (const entry of directory.files as any[]) {
        const entryPath: string = entry.path;
        const target = resolve(root, entryPath);
        const contained = target === root || target.startsWith(rootPrefix);

        // Reject traversal explicitly. The library used to drop these silently, so the
        // caller was told "success" about a partial extraction and the archive's
        // suspicious content was never surfaced (filesystem-mcp#26).
        if (isAbsolute(entryPath) || !contained) {
          skipped.push({ entry: entryPath, reason: 'path traversal' });
          continue;
        }

        if (entry.type === 'Directory') {
          await fs.mkdir(target, { recursive: true });
          continue;
        }

        await fs.mkdir(dirname(target), { recursive: true });
        await pipeline(entry.stream(), createWriteStream(target));
        entries.push(entryPath);
      }

      return {
        success: true,
        message: skipped.length
          ? `Archive extracted with ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} skipped`
          : 'Archive extracted successfully',
        path: destination,
        data: {
          archivePath,
          destination,
          extracted: entries.length,
          entries,
          skipped,
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to extract archive: ${error instanceof Error ? error.message : 'Unknown error'}`,
        path: destination,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Convert fs.Stats to FileInfo
   */
  private static statsToFileInfo(path: string, stats: Stats): FileWatchEvent['stats'] {
    return {
      name: basename(path),
      path,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      isSymlink: stats.isSymbolicLink(),
      permissions: stats.mode.toString(8),
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      accessedAt: stats.atime,
      extension: extname(path) || undefined,
      mimeType: undefined
    };
  }

  /**
   * Format bytes to human readable string
   */
  private static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Cleanup all watchers
   */
  static async cleanup(): Promise<void> {
    for (const [, watcher] of this.watchers) {
      try {
        await watcher.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.watchers.clear();
  }
}
