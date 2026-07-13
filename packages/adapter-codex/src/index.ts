/**
 * @vibecook/chopsticks-adapter-codex — Codex native adapter.
 *
 * Codex's native surface is a structured JSON-RPC `app-server` protocol (M5;
 * draft/CODEX-SURFACE-FINDINGS.md), so this adapter is a structured driver, not
 * a PTY+transcript clone of the Claude adapter. C2 ships the notification
 * normalizer; the driver, detection, and structured injection follow (C3–C4).
 */

export * from './normalizer.js';
