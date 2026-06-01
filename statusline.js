#!/usr/bin/env node
/**
 * Claude Code status line.
 *
 * Reads the session JSON from stdin and prints a single status line:
 *
 *   ~/path | sonnet-4.6 | 12% ctx | 1m4s | +$0.0123 / $0.8572
 *
 * Design notes:
 *  - Model name comes from model.display_name (e.g. "Opus 4.8"), falling
 *    back to model.id when the display name has no version. New models like
 *    opus-5 render correctly without edits.
 *  - Per-turn cost is the delta of the cumulative cost.total_cost_usd that
 *    Claude Code reports
 *  - The idle timer reads the transcript to find the last *main-session*
 *    activity (any user prompt or tool turn), skipping subagent sidechain
 *    entries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ---- Constants ------------------------------------------------------------

const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const SECS_PER_HOUR = 3600;
const DEFAULT_CACHE_TTL_SEC = 300;
const LONG_CACHE_TTL_SEC = SECS_PER_HOUR;
const CTX_RED_PCT = 80;
const CTX_YELLOW_PCT = 50;
const CACHE_WARN_RATIO = 0.9;
const COST_DECIMAL_PLACES = 4;

// ---- ANSI colors ----------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  orange: '\x1b[38;5;208m', // 256-color orange
};

const paint = (color, text) => `${color}${text}${C.reset}`;

// ---- Input ----------------------------------------------------------------

const readInput = () => {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')); // fd 0 = stdin
  } catch {
    return {};
  }
};

// ---- Model name ------------------------------------------------------------

/**
 * Turn a model id into a short label.
 *   claude-opus-4-7-20250101 -> opus-4.7
 *   claude-sonnet-4-6        -> sonnet-4.6
 *   claude-haiku-4-5-...     -> haiku-4.5
 *   claude-opus-5-...        -> opus-5      (future-proof)
 * Falls back to display_name, then the raw id.
 */
const shortModelName = (id, displayName) => {
  // Prefer display_name when it already carries a version, e.g. "Opus 4.8".
  // This is the marketed version and avoids id-format quirks (some ids put the
  // release date right after the major version, hiding the minor).
  if (typeof displayName === 'string' && /\d/.test(displayName)) {
    let name = displayName.trim();
    // Note a 1M long-context variant before discarding the "(...)" qualifier.
    const longContext = /\b1m\b/i.test(name);
    name = name
        .replace(/\s*\([^)]*\)\s*/g, ' ') // drop "(1M context)" and similar
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/^claude-/, '');
    return longContext ? `${name} 1M` : name;
  }
  // Otherwise derive from the id: claude-opus-4-7-... -> opus-4.7
  if (typeof id === 'string') {
    const m = id.match(/^claude-(opus|sonnet|haiku)-(.+)$/);
    if (m) {
      const [, family, rest] = m;
      const versionParts = [];
      for (const seg of rest.split('-')) {
        // version segments are short numbers (4, 7); the trailing date is 8 digits
        if (!/^\d{1,2}$/.test(seg)) break;
        versionParts.push(seg);
      }
      return versionParts.length ? `${family}-${versionParts.join('.')}` : family;
    }
  }
  if (displayName) return String(displayName).toLowerCase().replace(/\s+/g, '-');
  return id || 'unknown';
};

// ---- Cost (delta of cumulative total) -------------------------------------

/**
 * Returns { turn, total } in USD. The per-turn figure is how much the
 * cumulative cost grew since the previous render, tracked in a per-session
 * temp file. Model-agnostic: no price table.
 */
const costs = (input) => {
  const total = Number(input?.cost?.total_cost_usd ?? 0);
  const sessionId = input?.session_id || '';
  if (!sessionId) return { turn: total, total };

  const stateFile = path.join(os.tmpdir(), `cc-statusline-${sessionId}.json`);
  let prev = total;
  try {
    prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')).prevCost ?? total;
  } catch {
    /* first render of this session */
  }
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ prevCost: total }));
  } catch {
    /* tmp not writable; degrade gracefully */
  }
  return { turn: Math.max(0, total - prev), total };
};

// ---- Idle timer (last main-session activity from the transcript) ----------

/**
 * Epoch seconds of the most recent NON-subagent entry in the transcript,
 * or null. Reads only the tail of the file so it stays fast on long sessions.
 */
const lastMainActivityEpoch = (transcriptPath) => {
  if (!transcriptPath) return null;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const { size } = fs.fstatSync(fd);
    const readLen = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    fs.closeSync(fd);

    const lines = buf.toString().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // partial first line from the tail read, or non-JSON
      }
      if (entry.isSidechain) continue; // skip subagent turns
      const t = Date.parse(entry.timestamp);
      if (!Number.isNaN(t)) return Math.floor(t / 1000);
    }
  } catch {
    /* no transcript / unreadable */
  }
  return null;
};

const formatElapsed = (sec) => {
  if (sec >= SECS_PER_HOUR) {
    const h = Math.floor(sec / SECS_PER_HOUR);
    const m = Math.floor((sec % SECS_PER_HOUR) / 60);
    return `${h}h${m}m`;
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${sec}s`;
};

// ---- Working directory ----------------------------------------------------

const prettyCwd = (input) => {
  const dir = input?.workspace?.current_dir || input?.cwd || process.cwd();
  const home = os.homedir();
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
};

// ---- Assemble -------------------------------------------------------------

const main = () => {
  const input = readInput();

  const cwd = prettyCwd(input);
  const model = shortModelName(input?.model?.id, input?.model?.display_name);

  const ctxPct = Number(input?.context_window?.used_percentage ?? 0);
  const ctxColor = ctxPct >= CTX_RED_PCT ? C.red : ctxPct >= CTX_YELLOW_PCT ? C.yellow : C.green;

  const { turn, total } = costs(input);

  // Cache TTL: 1h if the env flag is set, otherwise the 5m default.
  const ttlSec = process.env.ENABLE_PROMPT_CACHING_1H === 'true' ? LONG_CACHE_TTL_SEC : DEFAULT_CACHE_TTL_SEC;
  const lastActivity = lastMainActivityEpoch(input?.transcript_path);

  const parts = [
    paint(C.magenta, cwd),
    paint(C.green, model),
    `${paint(ctxColor, `${ctxPct}%`)} ctx`,
  ];

  if (lastActivity !== null) {
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - lastActivity);
    // normal (default fg) while fresh, orange as it nears the cache TTL, red past it
    const timerColor = elapsed >= ttlSec ? C.red : elapsed >= ttlSec * CACHE_WARN_RATIO ? C.orange : '';
    parts.push(paint(timerColor, formatElapsed(elapsed)));
  }

  parts.push(paint(C.cyan, `+$${turn.toFixed(COST_DECIMAL_PLACES)} / $${total.toFixed(COST_DECIMAL_PLACES)}`));

  process.stdout.write(parts.join(' | '));
};

main();
