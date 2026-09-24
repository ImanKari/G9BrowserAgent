/**
 * Append-only line logs under G9_HOME/logs (install.log for the wizard, desktop.log for the rest).
 *
 * Synchronous appends on purpose: the wizard's log is what a person reads when setup went wrong,
 * and a buffered line lost to a crash is exactly the line they needed. Volume is tiny.
 * A failure to write a log never fails the action being logged.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export function formatLine(level, message, data, now = new Date()) {
  let line = `${now.toISOString()} ${String(level).toUpperCase().padEnd(5)} ${message}`;
  if (data !== undefined) {
    let text;
    try {
      text = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      text = String(data);
    }
    if (text && text.length > 4000) text = `${text.slice(0, 4000)}… (${text.length} chars)`;
    if (text) line += ` ${text}`;
  }
  return `${line}\n`;
}

/**
 * @param {string} file absolute path of the log file
 * @returns {{ info, warn, error, file }} each `(message, data?) => void`
 */
export function createLogger(file, { echo = false } = {}) {
  const write = (level, message, data) => {
    const line = formatLine(level, message, data);
    if (echo) process.stderr.write(line);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Keep one previous generation: a log nobody rotates eventually becomes the problem.
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* logging must never break the action */
    }
  };
  return {
    file,
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

/** Read the tail of a log for display (the Setup view shows the last lines of install.log). */
export function tailLog(file, maxLines = 200) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
