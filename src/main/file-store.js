'use strict';

/**
 * ============================================================
 *  FileStore – A lightweight, encrypted JSON store
 *  Replaces electron-store to avoid ESM compatibility issues
 *  in packaged Electron builds on Windows.
 * ============================================================
 *
 *  Data is AES-encrypted and stored as a single JSON file
 *  inside the app's userData directory.
 *
 *  API is compatible with electron-store:
 *    store.get(key)
 *    store.set(key, value)
 *    store.delete(key)
 *    store.clear()
 *    store.path  (read-only, path to the JSON file)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

class FileStore {
  /**
   * @param {object} opts
   * @param {string} opts.name      – base name of the JSON file (without extension)
   * @param {string} opts.cwd       – directory to store the file (defaults to userData)
   * @param {string} [opts.encryptionKey] – if provided, data is AES-encrypted on disk
   */
  constructor(opts = {}) {
    const { app } = require('electron');
    const name = opts.name || 'config';
    const cwd = opts.cwd || app.getPath('userData');

    this._filePath = path.join(cwd, `${name}.json`);
    this._encryptionKey = opts.encryptionKey || null;
    this._data = {};

    // Ensure directory exists
    const dir = path.dirname(this._filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load existing data
    this._load();
  }

  /** Full path to the store file */
  get path() {
    return this._filePath;
  }

  /** Get a value by key */
  get(key) {
    return this._data[key];
  }

  /** Set a key-value pair (persists immediately) */
  set(key, value) {
    if (typeof key === 'object' && value === undefined) {
      // Allow: store.set({ key1: val1, key2: val2 })
      Object.assign(this._data, key);
    } else {
      this._data[key] = value;
    }
    this._save();
  }

  /** Delete a key */
  delete(key) {
    delete this._data[key];
    this._save();
  }

  /** Check if a key exists */
  has(key) {
    return key in this._data;
  }

  /** Clear all data */
  clear() {
    this._data = {};
    this._save();
  }

  /** Get all data as a plain object */
  get store() {
    return { ...this._data };
  }

  // ─── PRIVATE ──────────────────────────────────────────────

  _load() {
    try {
      if (!fs.existsSync(this._filePath)) {
        this._data = {};
        return;
      }

      const raw = fs.readFileSync(this._filePath, 'utf-8');

      if (this._encryptionKey) {
        this._data = this._decrypt(raw);
      } else {
        this._data = JSON.parse(raw);
      }
    } catch (err) {
      console.error(`[FileStore] Failed to load ${this._filePath}:`, err.message);
      // If the file is corrupted, start fresh but keep a backup
      try {
        const backupPath = this._filePath + '.corrupt.' + Date.now();
        if (fs.existsSync(this._filePath)) {
          fs.copyFileSync(this._filePath, backupPath);
          fs.unlinkSync(this._filePath); // Delete the corrupt file
          console.error(`[FileStore] Corrupted file backed up and removed: ${backupPath}`);
        }
      } catch (e) { /* ignore */ }
      this._data = {};
    }
  }

  _save() {
    try {
      let content;
      if (this._encryptionKey) {
        content = this._encrypt(this._data);
      } else {
        content = JSON.stringify(this._data, null, 2);
      }

      // Write atomically: write to temp file, then rename
      const tmpPath = this._filePath + '.tmp';
      fs.writeFileSync(tmpPath, content, 'utf-8');
      
      try {
        fs.renameSync(tmpPath, this._filePath);
      } catch (renameErr) {
        // On Windows, renameSync can fail if the destination is locked or on a different drive
        if (process.platform === 'win32') {
          try {
            if (fs.existsSync(this._filePath)) {
               fs.unlinkSync(this._filePath); // Try to delete the locked file first
            }
          } catch (e) { /* ignore */ }
          try {
            fs.renameSync(tmpPath, this._filePath);
          } catch (err2) {
             // If rename still fails, try copy which might work across drives or locks
             fs.copyFileSync(tmpPath, this._filePath);
             fs.unlinkSync(tmpPath);
          }
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      console.error(`[FileStore] Failed to save ${this._filePath}:`, err.message);
      // Direct write fallback
      try {
        const content = this._encryptionKey
          ? this._encrypt(this._data)
          : JSON.stringify(this._data, null, 2);
        fs.writeFileSync(this._filePath, content, 'utf-8');
      } catch (e) {
        console.error(`[FileStore] Direct write also failed:`, e.message);
      }
    }
  }

  _deriveKey() {
    // Derive a 32-byte key from the encryption passphrase
    return crypto.createHash('sha256').update(this._encryptionKey).digest();
  }

  _encrypt(data) {
    const key = this._deriveKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const json = JSON.stringify(data);
    let encrypted = cipher.update(json, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    // Store as: iv_hex:encrypted_hex
    return iv.toString('hex') + ':' + encrypted;
  }

  _decrypt(raw) {
    const key = this._deriveKey();
    const parts = raw.split(':');
    if (parts.length < 2) {
      throw new Error('Invalid encrypted data format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts.slice(1).join(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  }
}

module.exports = FileStore;
