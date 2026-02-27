# Log File Tailer

A real-time log file monitoring module that detects new content appended to a file using a native file watcher with a periodic polling fallback.

## Capabilities

### Reads newly appended content from a log file

Tracks the last-read byte offset. When the file size increases beyond the last offset, reads exactly the new bytes and returns them as a string. Supports UTF-8 encoding for real-time log files (LiveLog mode) and UTF-16LE encoding for standard journal files.

- Reading a file that has grown from 0 to 10 bytes returns the 10 new bytes decoded as UTF-8 [@test](./tests/read_new_bytes_utf8.test.js)
- Reading a file that has grown returns only the new bytes since the last read, not the entire file [@test](./tests/read_incremental.test.js)

### Detects file truncation

When the current file size is less than the tracked last-read offset (indicating the file was cleared or rotated), resets the offset to zero.

- After reading 100 bytes, if the file shrinks to 20 bytes, the next check resets the offset to 0 [@test](./tests/detect_truncation.test.js)

### Polls for changes as a fallback

In addition to the native file watcher, a periodic polling loop (using `setTimeout`) checks for new content at a slower interval (e.g., every 5 seconds). The poller stops when `isTailing` is `false`.

- After calling `stop()`, the polling timer is not rescheduled [@test](./tests/stop_polling.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
const fs = require('fs');

class LogTailer {
    constructor() {
        this.isTailing = false;
        this.lastSize = 0;
        this.currentFilePath = null;
        this.mode = 'livelog'; // 'livelog' (UTF-8) or 'standard' (UTF-16LE)
    }

    /** Start tailing a file */
    start(filePath, mode) {}

    /** Stop tailing */
    stop() {}

    /** Check if file has grown and read new bytes */
    checkForNewContent() {}

    /** Read new bytes since lastSize, decode according to mode, return content string */
    readNewLines(newSize) {}

    /** Backup polling loop */
    poll() {}
}

module.exports = { LogTailer };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides real-time MQL runtime log tailing that streams MetaTrader Expert Advisor output to a VS Code output channel.

[@satisfied-by](mql-clangd)
